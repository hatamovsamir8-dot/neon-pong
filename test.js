// Автотест: два виртуальных игрока создают комнату, играют, проверяют физику и реконнект.
const WebSocket = require('ws');
const URL = 'ws://127.0.0.1:' + (process.env.PORT || 3000) + '/ws';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (cond, name) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) failures++;
};

function client() {
  const ws = new WebSocket(URL);
  const c = { ws, last: null, joined: null, error: null, states: 0 };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 's') { c.last = m; c.states++; }
    if (m.t === 'joined') c.joined = m;
    if (m.t === 'error') c.error = m;
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.ready = () => new Promise(r => ws.on('open', r));
  return c;
}

(async () => {
  console.log('1) Создание комнаты и подключение второго игрока');
  const a = client(); await a.ready();
  a.send({ t: 'create' });
  await sleep(300);
  ok(a.joined && a.joined.side === 0, 'игрок A создал комнату и играет слева');
  const room = a.joined.room;

  const b = client(); await b.ready();
  b.send({ t: 'join', room });
  await sleep(300);
  ok(b.joined && b.joined.side === 1, 'игрок B вошёл по коду комнаты и играет справа');
  ok(a.last && a.last.ph === 'count', 'пошёл обратный отсчёт');

  console.log('2) Отсчёт → игра, состояние летит 60 раз/сек');
  await sleep(3500);
  ok(a.last.ph === 'play', 'фаза игры началась');
  const s1 = a.states; await sleep(1000); const s2 = a.states;
  ok(s2 - s1 >= 50, `частота состояний ~60/сек (получено ${s2 - s1})`);

  console.log('3) Управление ракеткой');
  b.send({ t: 'move', y: 0.1 });
  await sleep(700);
  ok(a.last.p[1] < 100, 'ракетка B поехала вверх по команде move');

  console.log('4) Мяч двигается, гол засчитывается');
  // ждём фазу игры (между голами бывает пауза с отсчётом)
  for (let i = 0; i < 20 && a.last.ph !== 'play'; i++) await sleep(300);
  const bx1 = a.last.b[0]; await sleep(300);
  ok(a.last.ph === 'play' && a.last.b[0] !== bx1, 'мяч летит');
  // ракетки прижаты к краям — мяч должен залететь в ворота
  a.send({ t: 'move', y: 0 }); b.send({ t: 'move', y: 1 });
  let scored = false;
  for (let i = 0; i < 40; i++) { await sleep(500); if (a.last.sc[0] + a.last.sc[1] >= 1) { scored = true; break; } }
  ok(scored, `гол засчитан, счёт ${a.last.sc[0]}:${a.last.sc[1]}`);

  console.log('5) Переподключение по токену (обновление страницы)');
  const tokenA = a.joined.token;
  a.ws.close();
  await sleep(400);
  ok(b.last.ph === 'wait' && b.last.op === false, 'у B игра встала на паузу, соперник отключён');
  const a2 = client(); await a2.ready();
  a2.send({ t: 'join', room, token: tokenA });
  await sleep(400);
  ok(a2.joined && a2.joined.side === 0, 'A вернулся в свой слот по токену');
  ok(a2.last && (a2.last.ph === 'count' || a2.last.ph === 'play'), 'игра возобновилась');
  ok(a2.last.sc[0] + a2.last.sc[1] >= 1, 'счёт сохранился после реконнекта');

  console.log('6) Третий лишний');
  const c = client(); await c.ready();
  c.send({ t: 'join', room });
  await sleep(300);
  ok(c.error && /заполнена/.test(c.error.msg), 'третьему игроку вежливый отказ');

  a2.ws.close(); b.ws.close(); c.ws.close();
  console.log(failures === 0 ? '\nВСЕ ТЕСТЫ ПРОЙДЕНЫ ✅' : `\nПРОВАЛЕНО: ${failures} ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
