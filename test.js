'use strict';
// Self-contained test: runs the app against an in-memory database and fake ESPN data.
const http = require('node:http');
const assert = require('node:assert/strict');
const { createApp, openDb, makeEspn } = require('./server');

const H = 3600e3, now = Date.now();
const ev = (away, home, offsetMs, st = {}) => ({
  date: new Date(now + offsetMs).toISOString(),
  competitions: [{ competitors: [
    { homeAway: 'away', team: { abbreviation: away }, score: st.as, winner: st.aw },
    { homeAway: 'home', team: { abbreviation: home }, score: st.hs, winner: st.hw },
  ], status: { type: st.type || { name: 'STATUS_SCHEDULED', state: 'pre', completed: false, shortDetail: '' } } }],
});
const FINAL = { name: 'STATUS_FINAL', state: 'post', completed: true, shortDetail: 'Final' };
const week8 = { events: [
  ev('CAR', 'GB', -72 * H, { type: FINAL, as: '17', hs: '24', aw: false, hw: true }),           // GB won
  ev('IND', 'JAX', -50 * H, { type: FINAL, as: '31', hs: '20', aw: true, hw: false }),          // IND won
  ev('LA', 'WSH', -1 * H, { type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false, shortDetail: 'Q3 5:12' }, as: '10', hs: '7' }), // live, alias codes
  ev('KC', 'DEN', 48 * H),
  ev('PHI', 'NYG', 72 * H),
]};
let espnCalls = 0;
const fakeFetch = async (url) => {
  espnCalls++;
  if (!url.includes('week=')) return { ok: true, json: async () => ({ season: { year: 2026, type: 2 }, week: { number: 8 } }) };
  if (url.includes('week=8')) return { ok: true, json: async () => week8 };
  return { ok: false, status: 500, json: async () => ({}) };
};

(async () => {
  const server = http.createServer(createApp({ db: openDb(':memory:'), espn: makeEspn(fakeFetch) }));
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };

  let r = await call('GET', '/');
  assert.equal(r.status, 200); assert.match(String(r.data), /PICK'EM/);

  r = await call('GET', '/api/me');
  assert.deepEqual([r.data.user, r.data.currentWeek], [null, 8]);

  r = await call('GET', '/api/schedule?week=8');
  assert.equal(r.data.games.length, 5);
  const live = r.data.games.find(g => g.state === 'in');
  assert.deepEqual([live.key, live.awayScore, live.homeScore], ['LAR-WAS', 10, 7]);
  assert.equal(r.data.games.find(g => g.key === 'CAR-GB').winner, 'GB');

  r = await call('GET', '/api/schedule?week=3');
  assert.equal(r.status, 502);

  r = await call('PUT', '/api/picks', { week: 8, key: 'KC-DEN', team: 'KC' });
  assert.equal(r.status, 401, 'picks need login');

  r = await call('POST', '/api/register', { username: 'jb', password: 'longenough' });
  assert.equal(r.status, 400, 'short username rejected');
  r = await call('POST', '/api/register', { username: 'jacob', password: 'short' });
  assert.equal(r.status, 400, 'short password rejected');
  r = await call('POST', '/api/register', { username: 'Jacob', password: 'supersecret1' });
  assert.equal(r.status, 200); assert.ok(cookie, 'session cookie set');
  r = await call('GET', '/api/me'); assert.equal(r.data.user.username, 'Jacob');

  // Picks: future game OK, started games locked, bad team rejected
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'KC-DEN', team: 'KC' })).status, 200);
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'KC-DEN', team: 'DEN' })).status, 200, 'change pick before kickoff');
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'CAR-GB', team: 'GB' })).status, 423, 'finished game locked');
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'LAR-WAS', team: 'LAR' })).status, 423, 'live game locked');
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'PHI-NYG', team: 'DAL' })).status, 400);

  // Import of browser picks: only unstarted, and never overwrites the account's pick
  r = await call('POST', '/api/picks/import', { picks: { 8: { 'KC-DEN': 'KC', 'PHI-NYG': 'PHI', 'CAR-GB': 'GB' } } });
  assert.deepEqual(r.data, { imported: 1, skipped: 1 });
  r = await call('GET', '/api/picks');
  assert.deepEqual(r.data.picks, { 8: { 'KC-DEN': 'DEN', 'PHI-NYG': 'PHI' } });

  // Grade: insert picks on finished/live games directly (as if made before kickoff), then check the record
  const db = openDb(':memory:');
  const espn = makeEspn(fakeFetch);
  const app2 = http.createServer(createApp({ db, espn })); await new Promise(res => app2.listen(0, res));
  db.exec(`INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'t','x',0)`);
  const token = 'a'.repeat(64), sha = require('node:crypto').createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha, 1, Date.now() + 1e7);
  const ins = db.prepare('INSERT INTO picks VALUES(1,2026,8,?,?,0)');
  ins.run('CAR-GB', 'GB'); ins.run('IND-JAX', 'JAX'); ins.run('LAR-WAS', 'LAR'); ins.run('KC-DEN', 'KC');
  const rr = await (await fetch('http://127.0.0.1:' + app2.address().port + '/api/record', { headers: { Cookie: 'pickem_session=' + token } })).json();
  assert.deepEqual(rr.weeks['8'], { correct: 1, wrong: 1, push: 0, pending: 2 });
  assert.deepEqual(rr.season, { correct: 1, wrong: 1, push: 0, pending: 2 });
  app2.close();

  // Logout / login
  await call('POST', '/api/logout'); assert.equal(cookie, '');
  assert.equal((await call('GET', '/api/picks')).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'jacob', password: 'wrongpass1' })).status, 401);
  r = await call('POST', '/api/login', { username: 'jacob', password: 'supersecret1' });
  assert.equal(r.status, 200, 'login is case-insensitive on username');
  assert.deepEqual((await call('GET', '/api/picks')).data.picks['8']['KC-DEN'], 'DEN', 'picks survive logout/login');

  // Lock in week 8: picks become final
  assert.equal((await call('POST', '/api/lock', { week: 9 })).status, 400, 'cannot lock a week with no picks');
  r = await call('POST', '/api/lock', { week: 8 });
  assert.deepEqual(r.data.lockedWeeks, [8]);
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'PHI-NYG', team: 'NYG' })).status, 423, 'locked week rejects changes');
  assert.equal((await call('PUT', '/api/picks', { week: 8, key: 'PHI-NYG', team: null })).status, 423, 'locked week rejects removals');
  assert.deepEqual((await call('GET', '/api/picks')).data.lockedWeeks, [8]);

  // Leaderboard across accounts (visible without logging in)
  const mine = cookie; cookie = '';
  await call('POST', '/api/register', { username: 'sam', password: 'password123' });
  await call('PUT', '/api/picks', { week: 8, key: 'KC-DEN', team: 'KC' });
  cookie = '';
  r = await call('GET', '/api/leaderboard?week=8');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.weekly.map(x => [x.username, x.picks, x.locked, x.pending]), [['Jacob', 2, true, 2], ['sam', 1, false, 1]]);
  assert.equal(r.data.season.length, 2); assert.equal(r.data.games, 5);
  cookie = mine;

  // Duplicate username
  cookie = '';
  assert.equal((await call('POST', '/api/register', { username: 'JACOB', password: 'anotherpass' })).status, 409);

  console.log('All tests passed. ESPN fetches:', espnCalls, '(cached between requests)');
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
