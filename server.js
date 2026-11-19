// NEON PONG — сервер: комнаты, авторитетная физика, рассылка состояния.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Логические размеры поля (клиент рисует в этих же координатах)
const W = 800, H = 500;
const PW = 12, PH = 90, PX = 30;      // ракетки: ширина, высота, отступ от края
const BR = 8;                          // радиус мяча
const WIN_SCORE = 7;
const PADDLE_SPEED = 560;              // px/сек — макс. скорость ракетки
const BALL_START = 380, BALL_MAX = 920, BALL_ACCEL = 1.05;
const DT = 1 / 60;

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  if (u === '/' || u === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(INDEX);
  } else if (u === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();

const rid = () => {
  let s;
  do { s = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(s));
  return s;
};
const newToken = () => crypto.randomBytes(12).toString('hex');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeRoom() {
  const room = {
    id: rid(),
    slots: [null, null],            // {token, ws}
    phase: 'wait',                  // wait | count | play | over
    started: false,
    score: [0, 0],
    p: [H / 2 - PH / 2, H / 2 - PH / 2],   // верх ракетки
    target: [H / 2, H / 2],               // цель (центр ракетки), px
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0, speed: BALL_START },
    serveDir: Math.random() < 0.5 ? -1 : 1,
    cd: 0,
    winner: null,
    emptySince: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

function bothConnected(room) {
  return room.slots.every(s => s && s.ws && s.ws.readyState === 1);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function startCountdown(room, seconds) {
  room.phase = 'count';
  room.cd = seconds;
  room.ball.x = W / 2; room.ball.y = H / 2;
  room.ball.vx = 0; room.ball.vy = 0;
  room.ball.speed = BALL_START;
}

function serve(room) {
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // ±45°
  const b = room.ball;
  b.speed = BALL_START;
  b.vx = Math.cos(angle) * b.speed * room.serveDir;
  b.vy = Math.sin(angle) * b.speed;
  room.phase = 'play';
}

function attach(room, side, ws, token) {
  const old = room.slots[side];
  if (old && old.ws && old.ws.readyState === 1 && old.ws !== ws) {
    try { old.ws.close(4000, 'replaced'); } catch (e) {}
  }
  room.slots[side] = { token, ws };
  ws._room = room; ws._side = side;
  send(ws, { t: 'joined', room: room.id, token, side });
  if (bothConnected(room)) {
    if (!room.started) {
      room.started = true;
      room.score = [0, 0];
      room.winner = null;
      startCountdown(room, 3);
    } else if (room.phase === 'wait') {
      startCountdown(room, 2); // возобновление после паузы
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws._room = null; ws._side = -1;

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'ping') { send(ws, { t: 'pong' }); return; }

    if (m.t === 'create') {
      const room = makeRoom();
      attach(room, 0, ws, newToken());
      return;
    }

    if (m.t === 'join') {
      const room = rooms.get(String(m.room || '').toUpperCase());
      if (!room) { send(ws, { t: 'error', msg: 'Комната не найдена. Возможно, игра уже закончилась.' }); return; }
      // Возврат по токену (обновление страницы / переподключение)
      if (m.token) {
        for (let i = 0; i < 2; i++) {
          if (room.slots[i] && room.slots[i].token === m.token) { attach(room, i, ws, m.token); return; }
        }
      }
      const free = room.slots.findIndex(s => !s || !s.ws || s.ws.readyState !== 1);
      if (free === -1) { send(ws, { t: 'error', msg: 'Комната заполнена: здесь уже играют двое 🎮' }); return; }
      // если слот был занят отключившимся игроком без токена — переиспользуем слот, но с новым токеном
      attach(room, free, ws, (room.slots[free] && room.slots[free].token) || newToken());
      return;
    }

    const room = ws._room, side = ws._side;
    if (!room || side < 0) return;

    if (m.t === 'move') {
      const y = Number(m.y);
      if (Number.isFinite(y)) room.target[side] = clamp(y, 0, 1) * H;
      return;
    }

    if (m.t === 'rematch') {
      if (room.phase === 'over' && bothConnected(room)) {
        room.score = [0, 0];
        room.winner = null;
        room.serveDir = Math.random() < 0.5 ? -1 : 1;
        startCountdown(room, 3);
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = ws._room, side = ws._side;
    if (!room || side < 0) return;
    const slot = room.slots[side];
    if (slot && slot.ws === ws) {
      slot.ws = null;
      if (room.phase === 'play' || room.phase === 'count') room.phase = 'wait';
      if (!room.slots.some(s => s && s.ws && s.ws.readyState === 1)) room.emptySince = Date.now();
    }
  });
});

// Игровой цикл: физика + рассылка состояния
setInterval(() => {
  for (const room of rooms.values()) {
    const anyone = room.slots.some(s => s && s.ws && s.ws.readyState === 1);
    if (!anyone) continue;

    if (room.phase === 'count') {
      room.cd -= DT;
      if (room.cd <= 0) serve(room);
    }

    // ракетки всегда могут двигаться (и в отсчёте тоже)
    if (room.phase === 'count' || room.phase === 'play') {
      for (let i = 0; i < 2; i++) {
        const center = room.p[i] + PH / 2;
        const diff = room.target[i] - center;
        const step = clamp(diff, -PADDLE_SPEED * DT, PADDLE_SPEED * DT);
        room.p[i] = clamp(room.p[i] + step, 0, H - PH);
      }
    }

    if (room.phase === 'play') {
      const b = room.ball;
      b.x += b.vx * DT;
      b.y += b.vy * DT;

      // стены
      if (b.y - BR <= 0 && b.vy < 0) { b.y = BR; b.vy = -b.vy; }
      if (b.y + BR >= H && b.vy > 0) { b.y = H - BR; b.vy = -b.vy; }

      // левая ракетка
      if (b.vx < 0 && b.x - BR <= PX + PW && b.x - BR >= PX - 14 &&
          b.y >= room.p[0] - BR && b.y <= room.p[0] + PH + BR) {
        const rel = clamp((b.y - (room.p[0] + PH / 2)) / (PH / 2), -1, 1);
        const ang = rel * (Math.PI / 3); // до 60°
        b.speed = Math.min(b.speed * BALL_ACCEL, BALL_MAX);
        b.vx = Math.cos(ang) * b.speed;
        b.vy = Math.sin(ang) * b.speed;
        b.x = PX + PW + BR;
      }
      // правая ракетка
      const rx = W - PX - PW;
      if (b.vx > 0 && b.x + BR >= rx && b.x + BR <= rx + PW + 14 &&
          b.y >= room.p[1] - BR && b.y <= room.p[1] + PH + BR) {
        const rel = clamp((b.y - (room.p[1] + PH / 2)) / (PH / 2), -1, 1);
        const ang = rel * (Math.PI / 3);
        b.speed = Math.min(b.speed * BALL_ACCEL, BALL_MAX);
        b.vx = -Math.cos(ang) * b.speed;
        b.vy = Math.sin(ang) * b.speed;
        b.x = rx - BR;
      }

      // голы
      let scorer = -1;
      if (b.x < -20) scorer = 1;
      else if (b.x > W + 20) scorer = 0;
      if (scorer >= 0) {
        room.score[scorer]++;
        room.serveDir = scorer === 0 ? 1 : -1; // подача в сторону пропустившего
        if (room.score[scorer] >= WIN_SCORE) {
          room.phase = 'over';
          room.winner = scorer;
          b.vx = 0; b.vy = 0; b.x = W / 2; b.y = H / 2;
        } else {
          startCountdown(room, 2);
        }
      }
    }

    // рассылка каждому игроку (с флагом «соперник на связи»)
    for (let i = 0; i < 2; i++) {
      const s = room.slots[i];
      if (!s || !s.ws || s.ws.readyState !== 1) continue;
      const other = room.slots[1 - i];
      send(s.ws, {
        t: 's',
        ph: room.phase,
        b: [Math.round(room.ball.x * 10) / 10, Math.round(room.ball.y * 10) / 10],
        p: [Math.round(room.p[0] * 10) / 10, Math.round(room.p[1] * 10) / 10],
        sc: room.score,
        cd: Math.max(0, Math.round(room.cd * 10) / 10),
        w: room.winner,
        op: !!(other && other.ws && other.ws.readyState === 1),
      });
    }
  }
}, 1000 / 60);

// уборка пустых комнат (5 минут)
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const anyone = room.slots.some(s => s && s.ws && s.ws.readyState === 1);
    if (!anyone && now - room.emptySince > 5 * 60 * 1000) rooms.delete(id);
  }
}, 30 * 1000);

// обнаружение «мёртвых» соединений
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30 * 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NEON PONG запущен на 0.0.0.0:${PORT}`);
});
