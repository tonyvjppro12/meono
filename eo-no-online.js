const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const NOPE_WINDOW = 3000;
const MAX_PLAYERS = 5;
const ACTIONS = ['attack', 'skip', 'favor', 'shuffle', 'future'];
const CATS = ['tacocat', 'cattermelon', 'potato', 'rainbow', 'beard'];
const NAMES = {
  kitten: 'Mèo nổ', defuse: 'Gỡ bom', nope: 'Nope', attack: 'Tấn công', skip: 'Bỏ qua',
  favor: 'Nhờ vả', shuffle: 'Xáo bài', future: 'Nhìn trước', tacocat: 'Tacocat',
  cattermelon: 'Cattermelon', potato: 'Hairy Potato', rainbow: 'Rainbow', beard: 'Beard Cat'
};
const nm = c => NAMES[c.t === 'cat' ? c.k : c.t];
const clean = s => String(s || '').trim().slice(0, 20) || 'Người chơi';

// Đọc giao diện HTML được nhúng ở cuối file này
const PAGE_START = '/*@' + 'PAGE';
const PAGE_END = 'PAGE@' + '*/';
const selfSrc = fs.readFileSync(__filename, 'utf8');
const PAGE = selfSrc.slice(
  selfSrc.indexOf(PAGE_START) + PAGE_START.length,
  selfSrc.indexOf(PAGE_END, selfSrc.indexOf(PAGE_START))
);

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

const shuffle = a => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const makeCode = () => {
  let c;
  do c = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms.has(c));
  return c;
};
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const log = (room, text) => { room.log.push(text); if (room.log.length > 100) room.log.shift(); };

function newRoom(variant) {
  return {
    code: makeCode(), variant, players: [], started: false, phase: 'lobby',
    deck: [], discard: [], idx: 0, turnsLeft: 1, carry: 0,
    pending: null, prompt: null, kitten: null, winner: null, imp: false,
    log: [], timer: null, autoTimer: null
  };
}

function viewFor(room, me) {
  const pd = room.pending;
  return {
    code: room.code, me, variant: room.variant, started: room.started,
    idx: room.idx, phase: room.phase, over: room.phase === 'over', winner: room.winner,
    deckCount: room.deck.length, discardTop: room.discard[room.discard.length - 1] || null,
    pending: pd ? {
      kind: pd.kind, actor: pd.pi, cards: pd.cards, target: pd.target,
      cancelled: pd.cancelled, deadline: pd.deadline
    } : null,
    prompt: room.prompt && room.prompt.pi === me ? room.prompt : null,
    players: room.players.map(p => ({ name: p.name, alive: p.alive, count: p.hand.length, connected: p.connected })),
    hand: room.players[me] ? room.players[me].hand : [],
    log: room.log.slice(-50)
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => send(p.ws, { type: 'state', state: viewFor(room, i) }));
  autoPlay(room);
}

function after(room) {
  checkWin(room);
  broadcast(room);
}

function checkWin(room) {
  const alive = room.players.filter(p => p.alive);
  if (alive.length <= 1 && room.started && room.phase !== 'over') {
    room.phase = 'over';
    room.winner = alive[0] ? alive[0].name : null;
    log(room, `🏆 ${room.winner || 'Không ai'} thắng!`);
    return true;
  }
  return room.phase === 'over';
}

function startGame(room) {
  clearTimeout(room.timer); clearTimeout(room.autoTimer);
  const n = room.players.length;
  const cfg = {
    classic:   { kit: n - 1, def: 6, imp: false },
    party:     { kit: n + 1, def: 8, imp: false },
    imploding: { kit: n - 1, def: 6, imp: true }
  }[room.variant];

  let pool = [];
  for (const a of ['attack', 'skip', 'favor', 'shuffle']) for (let i = 0; i < 4; i++) pool.push({ t: a });
  for (let i = 0; i < 5; i++) { pool.push({ t: 'future' }); pool.push({ t: 'nope' }); }
  for (const k of CATS) for (let i = 0; i < 4; i++) pool.push({ t: 'cat', k });
  shuffle(pool);

  room.players.forEach(p => {
    p.alive = true;
    p.hand = [{ t: 'defuse' }];
    for (let i = 0; i < 7; i++) p.hand.push(pool.pop());
  });

  room.deck = [...pool];
  for (let i = 0; i < cfg.def - n; i++) room.deck.push({ t: 'defuse' });
  for (let i = 0; i < cfg.kit; i++) room.deck.push({ t: 'kitten' });
  shuffle(room.deck);

  Object.assign(room, {
    imp: cfg.imp, started: true, phase: 'play', idx: 0, turnsLeft: 1, carry: 0,
    discard: [], pending: null, prompt: null, kitten: null, winner: null, log: [],
    timer: null, autoTimer: null
  });
  log(room, `Bắt đầu ván (${room.variant}).`);
  broadcast(room);
}

function nextAlive(room, from) {
  let i = from;
  do i = (i + 1) % room.players.length; while (!room.players[i].alive);
  return i;
}

function endTurn(room) {
  room.turnsLeft--;
  if (room.turnsLeft > 0) return;
  room.idx = nextAlive(room, room.idx);
  room.turnsLeft = room.carry || 1;
  room.carry = 0;
}

function eliminate(room, pi, kitten) {
  const p = room.players[pi];
  room.discard.push(kitten, ...p.hand);
  p.hand = [];
  p.alive = false;
  log(room, `💥 ${p.name} bị loại!`);
}

// Trả về true nếu đang chờ người rút bài quyết định gỡ bom
function drawFor(room, pi) {
  const p = room.players[pi];
  if (room.deck.length === 0) { room.deck = shuffle(room.discard); room.discard = []; }
  const c = room.deck.shift();
  if (!c) return false;
  if (c.t !== 'kitten') {
    p.hand.push(c);
    log(room, `${p.name} rút một lá.`);
    return false;
  }
  log(room, `${p.name} rút phải 💣 Mèo nổ!`);
  const di = p.hand.findIndex(x => x.t === 'defuse');
  if (room.imp || di < 0) { eliminate(room, pi, c); return false; }
  room.phase = 'defuse';
  room.kitten = c;
  room.prompt = { kind: 'defuse', pi, max: room.deck.length };
  return true;
}

function doDraw(room) {
  if (drawFor(room, room.idx)) return broadcast(room);
  endTurn(room);
  after(room);
}

function resolveDefuse(room, use, pos) {
  const pi = room.prompt.pi, p = room.players[pi], kitten = room.kitten;
  room.prompt = null; room.kitten = null; room.phase = 'play';
  const di = p.hand.findIndex(x => x.t === 'defuse');
  if (use && di >= 0 && !room.imp) {
    room.discard.push(p.hand.splice(di, 1)[0]);
    const at = Number.isFinite(pos) ? Math.max(0, Math.min(room.deck.length, pos)) : room.deck.length;
    room.deck.splice(at, 0, kitten);
    log(room, `${p.name} đã gỡ bom và giấu Mèo nổ vào bộ bài.`);
  } else {
    eliminate(room, pi, kitten);
  }
  endTurn(room);
  after(room);
}

function requestPlay(room, pi, kind, cards, target) {
  room.phase = 'nope';
  room.pending = { kind, pi, cards, target, cancelled: false, deadline: Date.now() + NOPE_WINDOW };
  log(room, `${room.players[pi].name} chơi ${cards.map(nm).join(' + ')}.`);
  scheduleResolve(room);
  broadcast(room);
}

function scheduleResolve(room) {
  clearTimeout(room.timer);
  room.timer = setTimeout(() => resolvePending(room), NOPE_WINDOW);
}

function resolvePending(room) {
  const pend = room.pending;
  if (!pend) return;
  room.pending = null; room.timer = null;
  room.discard.push(...pend.cards);
  room.phase = 'play';
  if (pend.cancelled) {
    log(room, 'Hành động bị hủy.');
    return after(room);
  }
  execute(room, pend);
}

function execute(room, pend) {
  const actor = room.players[pend.pi];

  if (pend.kind === 'combo') {
    const t = room.players[pend.target];
    if (t && t.alive && t.hand.length) {
      const c = t.hand.splice(Math.floor(Math.random() * t.hand.length), 1)[0];
      actor.hand.push(c);
      log(room, `${actor.name} ăn cắp một lá ngẫu nhiên từ ${t.name}!`);
    }
    return after(room);
  }

  const card = pend.cards[0];
  switch (card.t) {
    case 'attack':
      room.carry = room.turnsLeft - 1 + 2;
      room.turnsLeft = 1;
      log(room, `${actor.name} tấn công: người sau phải đi ${room.carry} lượt.`);
      endTurn(room);
      break;
    case 'skip':
      log(room, `${actor.name} bỏ qua lượt.`);
      endTurn(room);
      break;
    case 'shuffle':
      room.deck = shuffle(room.deck);
      log(room, 'Bộ bài đã được xáo.');
      break;
    case 'future':
      send(actor.ws, { type: 'peek', cards: room.deck.slice(0, 3) });
      break;
    case 'favor': {
      const t = room.players[pend.target];
      if (t && t.alive && t.hand.length) {
        room.phase = 'favor';
        room.prompt = { kind: 'give', pi: pend.target, toPi: pend.pi, from: actor.name };
      }
      break;
    }
  }
  after(room);
}

function handlePlay(room, pi, cardIdx, target) {
  if (!Array.isArray(cardIdx) || room.phase !== 'play' || pi !== room.idx) return;
  const p = room.players[pi];
  const idxs = [...new Set(cardIdx)].filter(i => Number.isInteger(i) && i >= 0 && i < p.hand.length);
  if (!idxs.length) return;
  const picked = idxs.map(i => p.hand[i]);
  const validTarget = t => Number.isInteger(t) && t !== pi && room.players[t] &&
    room.players[t].alive && room.players[t].hand.length > 0;

  let kind, tgt = null;
  if (picked.length === 1 && ACTIONS.includes(picked[0].t)) {
    kind = 'action';
    if (picked[0].t === 'favor') {
      if (!validTarget(target)) return;
      tgt = target;
    }
  } else if (picked.length === 2 && picked[0].t === 'cat' && picked[1].t === 'cat' && picked[0].k === picked[1].k) {
    kind = 'combo';
    if (!validTarget(target)) return;
    tgt = target;
  } else {
    return;
  }

  idxs.sort((a, b) => b - a).forEach(i => p.hand.splice(i, 1));
  requestPlay(room, pi, kind, picked, tgt);
}

function handleNope(room, pi) {
  if (room.phase !== 'nope') return;
  const p = room.players[pi];
  const ni = p.hand.findIndex(x => x.t === 'nope');
  if (ni < 0) return;
  room.discard.push(p.hand.splice(ni, 1)[0]);
  room.pending.cancelled = !room.pending.cancelled;
  room.pending.deadline = Date.now() + NOPE_WINDOW;
  log(room, `🚫 ${p.name} dùng Nope!`);
  scheduleResolve(room);
  broadcast(room);
}

function handleGive(room, pi, index) {
  if (room.phase !== 'favor' || !room.prompt || room.prompt.pi !== pi) return;
  const giver = room.players[pi], to = room.players[room.prompt.toPi];
  const c = giver.hand[index];
  if (!c) return;
  giver.hand.splice(index, 1);
  to.hand.push(c);
  log(room, `${giver.name} đưa một lá cho ${to.name}.`);
  room.prompt = null;
  room.phase = 'play';
  after(room);
}

// Người mất kết nối sẽ được xử lý tự động để ván không bị treo
function autoPlay(room) {
  if (!room.started || room.phase === 'over' || room.autoTimer) return;
  let pi = null, act = null;
  if (room.phase === 'play') { pi = room.idx; act = () => doDraw(room); }
  else if (room.phase === 'defuse') { pi = room.prompt.pi; act = () => resolveDefuse(room, false, 0); }
  else if (room.phase === 'favor') { pi = room.prompt.pi; act = () => handleGive(room, pi, 0); }
  if (pi === null || room.players[pi].connected) return;
  const ph = room.phase;
  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (room.phase === ph && room.players[pi] && !room.players[pi].connected) act();
  }, 1500);
}

function join(room, ws, name) {
  room.players.push({ ws, name: clean(name), hand: [], alive: true, connected: true });
  ws.room = room;
  broadcast(room);
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.type === 'create') {
      if (ws.room) return;
      const variant = ['classic', 'party', 'imploding'].includes(m.variant) ? m.variant : 'classic';
      const room = newRoom(variant);
      rooms.set(room.code, room);
      return join(room, ws, m.name);
    }
    if (m.type === 'join') {
      if (ws.room) return;
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', msg: 'Không tìm thấy phòng.' });
      if (room.started) return send(ws, { type: 'error', msg: 'Ván đã bắt đầu.' });
      if (room.players.length >= MAX_PLAYERS) return send(ws, { type: 'error', msg: 'Phòng đã đầy.' });
      return join(room, ws, m.name);
    }

    const room = ws.room;
    if (!room) return;
    const pi = room.players.findIndex(p => p.ws === ws);
    if (pi < 0) return;

    switch (m.type) {
      case 'start':
        if (pi === 0 && !room.started && room.players.length >= 2) startGame(room);
        break;
      case 'restart':
        if (pi === 0 && room.phase === 'over') startGame(room);
        break;
      case 'draw':
        if (pi === room.idx && room.phase === 'play') doDraw(room);
        break;
      case 'play':
        handlePlay(room, pi, m.cards, m.target);
        break;
      case 'nope':
        handleNope(room, pi);
        break;
      case 'defuse':
        if (room.phase === 'defuse' && room.prompt.pi === pi) resolveDefuse(room, !!m.use, Number(m.pos));
        break;
      case 'give':
        handleGive(room, pi, Number(m.index));
        break;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    const pi = room.players.findIndex(p => p.ws === ws);
    if (pi < 0) return;
    if (!room.started) room.players.splice(pi, 1);
    else room.players[pi].connected = false;
    if (!room.players.some(p => p.connected)) {
      clearTimeout(room.timer); clearTimeout(room.autoTimer);
      rooms.delete(room.code);
      return;
    }
    broadcast(room);
  });
});

server.listen(PORT, () => console.log(`Mèo Nổ Online chạy tại http://localhost:${PORT}`));

/*@PAGE
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mèo Nổ Online</title>
<style>
  :root{--panel:#1f2a44;--text:#eef1f8;--muted:#9aa7c7;--accent:#ffb703}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:var(--text);min-height:100vh;
       background:radial-gradient(circle at top,#27365c,#0d1322 70%)}
  header{text-align:center;padding:18px 0 6px}
  header h1{margin:0;font-size:28px;letter-spacing:1px}
  .wrap{max-width:1000px;margin:0 auto;padding:12px}
  .panel{background:var(--panel);border-radius:16px;padding:16px;box-shadow:0 8px 30px #0008;margin-bottom:14px}
  input,select{padding:10px;border-radius:10px;border:1px solid #334;background:#0e1526;color:var(--text);font-size:15px}
  button{padding:10px 18px;border:0;border-radius:10px;background:linear-gradient(#4da3ff,#2d7fe0);
         color:#fff;font-size:15px;cursor:pointer;font-weight:600}
  button:disabled{background:#3a4560;color:#889;cursor:default}
  button.danger{background:linear-gradient(#ff6b6b,#d63c3c)}
  button.nope{background:linear-gradient(#666,#222)}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .seats{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .seat{background:#0e1526;border-radius:12px;padding:10px 14px;min-width:130px;text-align:center;
        border:2px solid transparent;transition:.2s}
  .seat.cur{border-color:var(--accent);box-shadow:0 0 12px #ffb70388}
  .seat.dead{opacity:.35}
  .seat.target{cursor:pointer;border-color:#5fd38d;animation:pulse 1s infinite}
  .seat .n{font-weight:700}
  .seat .s{font-size:13px;color:var(--muted)}
  @keyframes pulse{50%{transform:scale(1.05)}}
  .table{display:flex;justify-content:center;align-items:center;gap:40px;min-height:150px;flex-wrap:wrap;margin-bottom:12px}
  .pile{text-align:center;color:var(--muted);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:6px}
  .hand{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;min-height:150px}

  .card{width:104px;height:150px;border-radius:14px;padding:6px;color:#fff;cursor:pointer;flex-shrink:0;
        box-shadow:0 6px 16px #0007;border:3px solid #fff8;display:flex;flex-direction:column;
        align-items:center;justify-content:space-between;transition:transform .15s;user-select:none}
  .card:hover{transform:translateY(-4px)}
  .card.sel{transform:translateY(-14px);border-color:var(--accent);box-shadow:0 0 0 3px var(--accent),0 10px 20px #000a}
  .card .art{font-size:44px;width:72px;height:72px;border-radius:50%;background:#fff3;margin-top:6px;
             display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 3px #fff5;overflow:hidden}
  .card .art img{width:100%;height:100%;object-fit:cover}
  .card .cname{font-weight:700;font-size:13px;text-align:center;line-height:1.1;text-shadow:0 1px 2px #0008}
  .card.small{width:78px;height:112px}
  .card.small .art{font-size:30px;width:50px;height:50px}
  .card.small .cname{font-size:11px}
  .card.back{background:repeating-linear-gradient(45deg,#2b3a63 0 10px,#22305a 10px 20px);cursor:default}
  .card.back:hover{transform:none}
  .kitten{background:linear-gradient(160deg,#ff7a7a,#c9201f)}
  .defuse{background:linear-gradient(160deg,#6ee7a0,#1f9d55)}
  .nope{background:linear-gradient(160deg,#5b6275,#1b1f2b)}
  .attack{background:linear-gradient(160deg,#ffb46a,#e0650a)}
  .skip{background:linear-gradient(160deg,#7fd8ff,#1d7fc2)}
  .favor{background:linear-gradient(160deg,#dba0ff,#7b3fb8)}
  .shuffle{background:linear-gradient(160deg,#ffe36a,#c99a00)}
  .future{background:linear-gradient(160deg,#a8b1cc,#56627e)}
  .cat{background:linear-gradient(160deg,#fff1d6,#d8a866);color:#3a2410}
  .cat .cname{text-shadow:none}
  .cat .art{background:#fff8}

  .modal{position:fixed;inset:0;background:#000b;display:none;align-items:center;justify-content:center;z-index:9}
  .modal.show{display:flex}
  .modal .box{background:var(--panel);padding:20px;border-radius:16px;max-width:560px;width:92%;text-align:center}
  #pending{text-align:center;background:#0e1526;border-radius:12px;padding:10px;margin-bottom:10px}
  #log{height:150px;overflow:auto;font-size:14px;background:#0e1526;border-radius:10px;padding:8px}
  hr{border-color:#334}
</style>
</head>
<body>
<header><h1>🐱💣 Mèo Nổ Online</h1></header>

<div class="wrap">
  <section id="lobby" class="panel">
    <div class="row">
      <input id="name" placeholder="Tên của bạn" maxlength="20">
      <select id="variant">
        <option value="classic">Classic</option>
        <option value="party">Party (nhiều Mèo nổ & Gỡ bom)</option>
        <option value="imploding">Imploding (Mèo nổ không gỡ được)</option>
      </select>
      <button onclick="createRoom()">Tạo phòng mới</button>
    </div>
    <hr>
    <div class="row">
      <input id="code" placeholder="Mã phòng (4 ký tự)" maxlength="4" style="text-transform:uppercase">
      <button onclick="joinRoom()">Vào phòng</button>
    </div>
  </section>

  <section id="room" style="display:none">
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <div>Mã phòng: <b id="roomCode" style="font-size:20px;color:var(--accent)"></b>
          <small style="color:var(--muted)">(gửi mã này cho bạn bè)</small></div>
        <div id="turnTxt" style="font-weight:700"></div>
      </div>
    </div>

    <div id="waiting" class="panel" style="text-align:center">
      <h3>Đang chờ người chơi (2–5 người)</h3>
      <ul id="waitList" style="list-style:none;padding:0;color:var(--muted)"></ul>
      <button id="startBtn" onclick="send({type:'start'})">Bắt đầu ván</button>
    </div>

    <div id="game" style="display:none">
      <div class="panel">
        <div class="seats" id="seats"></div>
        <div id="hint" style="text-align:center;color:#5fd38d;min-height:20px;margin-top:8px"></div>
      </div>

      <div class="panel">
        <div class="table">
          <div class="pile" id="deck"></div>
          <div class="pile" id="discard"></div>
        </div>
        <div id="pending" style="display:none">
          <span id="pendingTxt"></span> · <b id="timer"></b>
        </div>
        <div class="row" style="justify-content:center">
          <button id="playBtn" onclick="playSelected()">Chơi lá đã chọn</button>
          <button id="drawBtn" class="danger" onclick="draw()">Rút bài & kết thúc lượt</button>
          <button id="nopeBtn" class="nope" onclick="send({type:'nope'})" style="display:none">🚫 NOPE!</button>
          <button id="cancelBtn" onclick="cancelTarget()" style="display:none">Hủy chọn mục tiêu</button>
        </div>
      </div>

      <div class="panel">
        <h3 style="margin-top:0">Bài của bạn</h3>
        <div class="hand" id="hand"></div>
      </div>

      <div class="panel">
        <h3 style="margin-top:0">Nhật ký</h3>
        <div id="log"></div>
      </div>
    </div>
  </section>
</div>

<div class="modal" id="defuseModal"><div class="box" id="defuseBox"></div></div>
<div class="modal" id="giveModal"><div class="box" id="giveBox"></div></div>
<div class="modal" id="peekModal">
  <div class="box">
    <h3>🔮 3 lá trên cùng</h3>
    <div class="hand" id="peekCards"></div><br>
    <button onclick="$('peekModal').classList.remove('show')">Đóng</button>
  </div>
</div>
<div class="modal" id="overModal"><div class="box" id="overBox"></div></div>

<script>
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ACTIONS = ['attack','skip','favor','shuffle','future'];

// Muốn dùng ảnh thật: thêm img:'đường_dẫn_hoặc_URL' vào từng lá.
const CARDS = {
  kitten:{n:'Mèo nổ',e:'💣',c:'kitten'},     defuse:{n:'Gỡ bom',e:'🛠️',c:'defuse'},
  nope:{n:'Nope',e:'🚫',c:'nope'},           attack:{n:'Tấn công',e:'⚔️',c:'attack'},
  skip:{n:'Bỏ qua',e:'⏭️',c:'skip'},         favor:{n:'Nhờ vả',e:'🙏',c:'favor'},
  shuffle:{n:'Xáo bài',e:'🔀',c:'shuffle'},  future:{n:'Nhìn trước',e:'🔮',c:'future'},
  tacocat:{n:'Tacocat',e:'🌮',c:'cat'},      cattermelon:{n:'Cattermelon',e:'🍉',c:'cat'},
  potato:{n:'Hairy Potato',e:'🥔',c:'cat'},   rainbow:{n:'Rainbow',e:'🌈',c:'cat'},
  beard:{n:'Beard Cat',e:'🧔',c:'cat'}
};
const cardKey = c => c.t === 'cat' ? c.k : c.t;

function cardHTML(c, i, opt = {}) {
  const d = CARDS[cardKey(c)];
  const art = d.img ? `<img src="${d.img}" alt="">` : d.e;
  return `<div class="card ${d.c} ${opt.sel ? 'sel' : ''} ${opt.small ? 'small' : ''}" ${i != null ? `data-i="${i}"` : ''}>
            <div class="art">${art}</div><div class="cname">${d.n}</div></div>`;
}

const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
const send = o => ws.send(JSON.stringify(o));
let S = null, selected = new Set(), targetMode = null, defuseBuilt = false;

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'state') { S = m.state; render(); }
  else if (m.type === 'peek') showPeek(m.cards);
  else if (m.type === 'error') alert(m.msg);
};
ws.onclose = () => alert('Mất kết nối máy chủ. Hãy tải lại trang.');

function createRoom() {
  send({ type:'create', name:$('name').value, variant:$('variant').value });
}
function joinRoom() {
  send({ type:'join', name:$('name').value, code:$('code').value.trim().toUpperCase() });
}

function render() {
  if (!S || !S.code) return;
  $('lobby').style.display = 'none';
  $('room').style.display = 'block';
  $('roomCode').textContent = S.code;

  const me = S.me;
  const myTurn = S.started && S.phase === 'play' && S.idx === me;

  $('waiting').style.display = S.started ? 'none' : 'block';
  $('game').style.display = S.started ? 'block' : 'none';
  if (!S.started) {
    $('waitList').innerHTML = S.players.map((p, i) =>
      `<li>${esc(p.name)}${i === 0 ? ' 👑' : ''}${i === me ? ' (bạn)' : ''}</li>`).join('');
    $('startBtn').style.display = me === 0 ? 'inline-block' : 'none';
    $('startBtn').disabled = S.players.length < 2;
    return;
  }

  if (targetMode && !myTurn) targetMode = null;
  $('turnTxt').textContent = S.over ? '' : myTurn ? 'Lượt của bạn' : `Lượt của ${S.players[S.idx].name}`;

  $('seats').innerHTML = S.players.map((p, i) => {
    const tgt = targetMode && i !== me && p.alive && p.count > 0;
    return `<div class="seat ${i === S.idx && !S.over ? 'cur' : ''} ${p.alive ? '' : 'dead'} ${tgt ? 'target' : ''}" data-i="${i}">
      <div class="n">${esc(p.name)}${i === me ? ' (bạn)' : ''}</div>
      <div class="s">${p.alive ? `🂠 ${p.count} lá` : '💀 Đã loại'}${p.connected ? '' : ' · mất kết nối'}</div>
    </div>`;
  }).join('');

  $('deck').innerHTML = `<div class="card back small"></div><div>Bộ bài: ${S.deckCount}</div>`;
  $('discard').innerHTML = S.discardTop
    ? `<div>Bỏ đi</div>${cardHTML(S.discardTop, null, {small:true})}`
    : '<div>Bỏ đi: trống</div>';

  const pd = S.pending;
  $('pending').style.display = pd ? 'block' : 'none';
  if (pd) {
    const names = pd.cards.map(c => CARDS[cardKey(c)].n).join(' + ');
    const tgt = pd.target != null ? ` → ${S.players[pd.target].name}` : '';
    $('pendingTxt').textContent =
      `${S.players[pd.actor].name} chơi ${names}${tgt}${pd.cancelled ? ' (đang bị hủy)' : ''}. Ai có Nope thì bấm ngay!`;
  }

  selected = new Set([...selected].filter(i => i < S.hand.length));
  $('hand').innerHTML = S.hand.map((c, i) => cardHTML(c, i, {sel: selected.has(i)})).join('');

  $('playBtn').disabled = !myTurn || S.over;
  $('drawBtn').disabled = !myTurn || S.over;
  $('cancelBtn').style.display = targetMode ? 'inline-block' : 'none';
  $('hint').textContent = targetMode ? 'Bấm vào một người chơi để làm mục tiêu' : '';
  $('nopeBtn').style.display = (S.phase === 'nope' && S.hand.some(c => c.t === 'nope')) ? 'inline-block' : 'none';

  $('log').innerHTML = S.log.map(l => `<div>${esc(l)}</div>`).join('');
  $('log').scrollTop = $('log').scrollHeight;

  renderModals();
}

function renderModals() {
  const pr = S.prompt;

  const dm = pr && pr.kind === 'defuse';
  $('defuseModal').classList.toggle('show', !!dm);
  if (!dm) defuseBuilt = false;
  if (dm && !defuseBuilt) {
    defuseBuilt = true;
    const canDefuse = S.hand.some(c => c.t === 'defuse');
    $('defuseBox').innerHTML = `
      <h2>💣 Bạn rút trúng Mèo nổ!</h2>
      ${canDefuse ? `
        <p>Đặt Mèo nổ lại vào bộ bài (0 = trên cùng, ${pr.max} = dưới cùng)</p>
        <input type="range" id="pos" min="0" max="${pr.max}" value="${pr.max}" style="width:100%">
        <div><b id="posTxt">${pr.max}</b></div>
        <div class="row" style="justify-content:center;margin-top:12px">
          <button onclick="defuse(true)">🛠️ Gỡ bom</button>
          <button class="danger" onclick="defuse(false)">Bỏ cuộc</button>
        </div>` : `
        <p>Bạn không còn Gỡ bom.</p>
        <button class="danger" onclick="defuse(false)">OK</button>`}`;
    const pos = $('pos');
    if (pos) pos.oninput = () => $('posTxt').textContent = pos.value;
  }

  const gm = pr && pr.kind === 'give';
  $('giveModal').classList.toggle('show', !!gm);
  if (gm) {
    $('giveBox').innerHTML = `
      <h2>🙏 ${esc(pr.from)} đang nhờ vả!</h2>
      <p>Chọn 1 lá để đưa cho họ</p>
      <div class="hand">${S.hand.map((c, i) => `<div data-g="${i}">${cardHTML(c)}</div>`).join('')}</div>`;
  }

  $('overModal').classList.toggle('show', !!S.over);
  if (S.over) {
    $('overBox').innerHTML = `
      <h2>🏆 ${esc(S.winner || 'Không ai')} thắng!</h2>
      ${S.me === 0
        ? '<button onclick="send({type:\'restart\'})">Ván mới</button>'
        : '<p>Chờ chủ phòng bắt đầu ván mới</p>'}`;
  }
}

function showPeek(cards) {
  $('peekCards').innerHTML = cards.length
    ? cards.map(c => cardHTML(c)).join('')
    : '<p>Bộ bài trống</p>';
  $('peekModal').classList.add('show');
}

function draw() {
  targetMode = null; selected.clear();
  send({ type:'draw' });
}

function playSelected() {
  const idx = [...selected].sort((a, b) => a - b);
  const cards = idx.map(i => S.hand[i]);
  if (cards.length === 1 && ACTIONS.includes(cards[0].t)) {
    if (cards[0].t === 'favor') { targetMode = idx; render(); return; }
    send({ type:'play', cards: idx });
    selected.clear();
    return;
  }
  if (cards.length === 2 && cards[0].t === 'cat' && cards[1].t === 'cat' && cards[0].k === cards[1].k) {
    targetMode = idx; render(); return;
  }
  alert('Chọn 1 lá hành động, hoặc 2 lá mèo giống nhau.');
}

function cancelTarget() { targetMode = null; render(); }

function defuse(use) {
  const pos = $('pos') ? Number($('pos').value) : 0;
  send({ type:'defuse', use, pos });
}

$('hand').onclick = e => {
  const el = e.target.closest('.card');
  if (!el) return;
  const i = +el.dataset.i;
  selected.has(i) ? selected.delete(i) : selected.add(i);
  render();
};
$('seats').onclick = e => {
  const el = e.target.closest('.seat');
  if (!el || !targetMode) return;
  const t = +el.dataset.i;
  if (t === S.me) return;
  send({ type:'play', cards: targetMode, target: t });
  targetMode = null; selected.clear(); render();
};
$('giveBox').onclick = e => {
  const el = e.target.closest('[data-g]');
  if (el) send({ type:'give', index: +el.dataset.g });
};

setInterval(() => {
  if (S && S.pending) $('timer').textContent =
    Math.max(0, Math.ceil((S.pending.deadline - Date.now()) / 1000)) + 's';
}, 200);
</script>
</body>
</html>
PAGE@*/