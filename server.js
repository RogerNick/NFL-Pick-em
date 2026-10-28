'use strict';
// NFL Pick'em server: accounts, saved picks, live results and scoring.
// Zero dependencies: uses Node's built-in http, crypto and sqlite modules (Node 22.13+).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 3000);
const SEASON = Number(process.env.SEASON || 2026);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'pickem.db');
const SIGNUP_CODE = process.env.SIGNUP_CODE || ''; // optional: require an invite code to create accounts
const SECURE_COOKIE = !!(process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production');
const COOKIE = 'pickem_session';
const SESSION_DAYS = 60;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';

const TEAM_CODES = new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS']);
const ALIASES = { LA: 'LAR', WSH: 'WAS', JAC: 'JAX' };
const norm = x => ALIASES[x] || x;

// ---------- Database ----------
function openDb(file = DB_FILE) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS picks(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      game_key TEXT NOT NULL,
      team TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, season, week, game_key));
    CREATE TABLE IF NOT EXISTS week_locks(
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      season INTEGER NOT NULL,
      week INTEGER NOT NULL,
      locked_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, season, week));`);
  return db;
}

// ---------- Passwords & sessions ----------
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return 'scrypt$' + salt.toString('hex') + '$' + key.toString('hex');
}
async function verifyPassword(pw, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  if (!saltHex || !keyHex) return false;
  const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
}

// Simple in-memory limiter for failed logins / signups per IP.
const attempts = new Map();
function limited(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.start > 15 * 60e3) return false;
  return a.count >= 10;
}
function noteFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.start > 15 * 60e3) attempts.set(ip, { start: Date.now(), count: 1 });
  else a.count++;
}

// ---------- ESPN schedule & results ----------
function parseEvent(e) {
  const comp = e.competitions?.[0] || {};
  const c = comp.competitors || [];
  const a = c.find(x => x.homeAway === 'away'), h = c.find(x => x.homeAway === 'home');
  const away = norm(a?.team?.abbreviation), home = norm(h?.team?.abbreviation);
  const st = comp.status?.type || e.status?.type || {};
  const name = String(st.name || '');
  const cancelled = /CANCEL|POSTPONE|SUSPEND/.test(name);
  const state = cancelled ? 'off' : (st.state || 'pre'); // pre | in | post | off
  const completed = !cancelled && !!st.completed;
  const awayScore = state === 'pre' || state === 'off' ? null : Number(a?.score ?? 0);
  const homeScore = state === 'pre' || state === 'off' ? null : Number(h?.score ?? 0);
  let winner = null;
  if (completed) {
    if (a?.winner) winner = away;
    else if (h?.winner) winner = home;
    else if (awayScore > homeScore) winner = away;
    else if (homeScore > awayScore) winner = home;
    else winner = 'TIE';
  }
  return { key: away + '-' + home, away, home, date: e.date, state, completed, winner,
    awayScore, homeScore, statusText: st.shortDetail || st.detail || '' };
}

function makeEspn(fetchImpl = (...args) => fetch(...args)) {
  const cache = new Map(), inflight = new Map();
  let current = { at: 0, week: 1 };

  async function fetchWeek(week) {
    const r = await fetchImpl(`${ESPN}?dates=${SEASON}&seasontype=2&week=${week}`, { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('ESPN returned ' + r.status);
    const data = await r.json();
    const games = (data.events || []).map(parseEvent)
      .filter(g => TEAM_CODES.has(g.away) && TEAM_CODES.has(g.home))
      .sort((x, y) => new Date(x.date) - new Date(y.date));
    if (!games.length) throw new Error('No matchups returned for week ' + week);
    return games;
  }

  async function getWeek(week, { force = false } = {}) {
    const hit = cache.get(week), now = Date.now();
    const fresh = hit && now - hit.at < hit.ttl;
    if (hit && (fresh && !(force && now - hit.at > 20e3))) return hit.games;
    if (inflight.has(week)) return inflight.get(week);
    const p = (async () => {
      try {
        const games = await fetchWeek(week);
        const t = Date.now();
        const live = games.some(g => g.state === 'in' || (!g.completed && g.state !== 'off' && new Date(g.date) <= t));
        const allDone = games.every(g => g.completed || g.state === 'off');
        cache.set(week, { at: t, ttl: live ? 60e3 : allDone ? 6 * 3600e3 : 15 * 60e3, games });
        return games;
      } catch (err) {
        if (hit) return hit.games; // stale data beats nothing
        throw err;
      } finally { inflight.delete(week); }
    })();
    inflight.set(week, p);
    return p;
  }

  async function currentWeek() {
    if (Date.now() - current.at < 3600e3) return current.week;
    try {
      const r = await fetchImpl(ESPN, { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      const year = d.season?.year, type = d.season?.type, n = d.week?.number;
      let w = 1;
      if (year && year > SEASON) w = 18;
      else if (year === SEASON) w = type === 2 && n ? n : type === 3 ? 18 : 1;
      current = { at: Date.now(), week: Math.min(18, Math.max(1, w)) };
    } catch { current = { at: Date.now() - 3300e3, week: current.week }; } // retry in ~5 min
    return current.week;
  }

  return { getWeek, currentWeek };
}

const isLocked = g => g.state !== 'pre' || Date.now() >= new Date(g.date).getTime();

function grade(games, weekPicks) {
  const s = { correct: 0, wrong: 0, push: 0, pending: 0 };
  for (const g of games) {
    const p = weekPicks[g.key];
    if (!p) continue;
    if (g.state === 'off') continue; // cancelled games don't count
    if (!g.completed) s.pending++;
    else if (g.winner === 'TIE') s.push++;
    else if (g.winner === p) s.correct++;
    else s.wrong++;
  }
  return s;
}

// ---------- HTTP app ----------
function createApp({ db, espn, clientDir = path.join(__dirname, 'client') }) {
  const q = {
    userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
    insertUser: db.prepare('INSERT INTO users(username, password_hash, created_at) VALUES(?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)'),
    sessionUser: db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    picksFor: db.prepare('SELECT week, game_key, team FROM picks WHERE user_id = ? AND season = ?'),
    upsertPick: db.prepare(`INSERT INTO picks(user_id, season, week, game_key, team, updated_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, season, week, game_key) DO UPDATE SET team = excluded.team, updated_at = excluded.updated_at`),
    insertPickIfNew: db.prepare(`INSERT INTO picks(user_id, season, week, game_key, team, updated_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, season, week, game_key) DO NOTHING`),
    deletePick: db.prepare('DELETE FROM picks WHERE user_id = ? AND season = ? AND week = ? AND game_key = ?'),
    locksFor: db.prepare('SELECT week FROM week_locks WHERE user_id = ? AND season = ?'),
    isWeekLocked: db.prepare('SELECT 1 FROM week_locks WHERE user_id = ? AND season = ? AND week = ?'),
    lockWeek: db.prepare('INSERT INTO week_locks(user_id, season, week, locked_at) VALUES(?, ?, ?, ?) ON CONFLICT DO NOTHING'),
    countWeekPicks: db.prepare('SELECT COUNT(*) AS n FROM picks WHERE user_id = ? AND season = ? AND week = ?'),
    allUsers: db.prepare('SELECT id, username FROM users ORDER BY username'),
    allPicks: db.prepare('SELECT user_id, week, game_key, team FROM picks WHERE season = ?'),
    allLocks: db.prepare('SELECT user_id, week FROM week_locks WHERE season = ?'),
  };

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
  }
  const fail = (status, error) => Object.assign(new Error(error), { status });

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(fail(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(fail(400, 'Invalid JSON')); } });
      req.on('error', reject);
    });
  }

  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return q.sessionUser.get(sha256(token), Date.now()) || null;
  }
  function startSession(res, userId) {
    q.purgeSessions.run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    q.insertSession.run(sha256(token), userId, Date.now() + SESSION_DAYS * 864e5);
    return sessionCookie(token, SESSION_DAYS * 86400);
  }
  function picksMap(userId) {
    const out = {};
    for (const r of q.picksFor.all(userId, SEASON)) (out[r.week] ??= {})[r.game_key] = r.team;
    return out;
  }
  const lockedWeeks = userId => q.locksFor.all(userId, SEASON).map(r => r.week).sort((a, b) => a - b);
  const weekLocked = (userId, week) => !!q.isWeekLocked.get(userId, SEASON, week);
  const validWeek = w => Number.isInteger(w) && w >= 1 && w <= 18;
  const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  const routes = {
    'GET /api/me': async (req) => ({
      user: (u => u && { username: u.username })(currentUser(req)),
      signupCodeRequired: !!SIGNUP_CODE, season: SEASON, currentWeek: await espn.currentWeek(),
    }),

    'POST /api/register': async (req, res) => {
      const ip = clientIp(req);
      if (limited(ip)) throw fail(429, 'Too many attempts. Try again in a few minutes.');
      const { username, password, code } = await readJson(req);
      const name = String(username || '').trim();
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(name)) throw fail(400, 'Username must be 3–20 letters, numbers, dots, dashes or underscores.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw fail(400, 'Password must be at least 8 characters.');
      if (SIGNUP_CODE && code !== SIGNUP_CODE) { noteFailure(ip); throw fail(403, 'That invite code is not right.'); }
      if (q.userByName.get(name)) throw fail(409, 'That username is taken.');
      const { lastInsertRowid } = q.insertUser.run(name, await hashPassword(password), Date.now());
      return [{ user: { username: name } }, { 'Set-Cookie': startSession(res, Number(lastInsertRowid)) }];
    },

    'POST /api/login': async (req, res) => {
      const ip = clientIp(req);
      if (limited(ip)) throw fail(429, 'Too many attempts. Try again in a few minutes.');
      const { username, password } = await readJson(req);
      const u = q.userByName.get(String(username || '').trim());
      if (!u || !(await verifyPassword(String(password || ''), u.password_hash))) { noteFailure(ip); throw fail(401, 'Wrong username or password.'); }
      return [{ user: { username: u.username } }, { 'Set-Cookie': startSession(res, u.id) }];
    },

    'POST /api/logout': async (req) => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (token) q.deleteSession.run(sha256(token));
      return [{ ok: true }, { 'Set-Cookie': sessionCookie('', 0) }];
    },

    'GET /api/schedule': async (req, res, url) => {
      const week = Number(url.searchParams.get('week'));
      if (!validWeek(week)) throw fail(400, 'Week must be 1–18.');
      try { return { week, games: await espn.getWeek(week, { force: url.searchParams.get('refresh') === '1' }) }; }
      catch { throw fail(502, 'Could not load the Week ' + week + ' schedule from ESPN. Try again shortly.'); }
    },

    'GET /api/picks': async (req) => {
      const u = currentUser(req); if (!u) throw fail(401, 'Log in first.');
      return { picks: picksMap(u.id), lockedWeeks: lockedWeeks(u.id) };
    },

    'PUT /api/picks': async (req) => {
      const u = currentUser(req); if (!u) throw fail(401, 'Log in to make picks.');
      const { week, key, team } = await readJson(req);
      if (!validWeek(week)) throw fail(400, 'Bad week.');
      if (weekLocked(u.id, week)) throw fail(423, 'You locked in your Week ' + week + ' picks, so they can’t be changed.');
      let games;
      try { games = await espn.getWeek(week); } catch { throw fail(503, 'Schedule unavailable right now, so picks can’t be checked. Try again shortly.'); }
      const g = games.find(x => x.key === key);
      if (!g) throw fail(404, 'That game isn’t on the Week ' + week + ' schedule.');
      if (isLocked(g)) throw fail(423, 'This game has kicked off, so its pick is locked.');
      if (team === null) q.deletePick.run(u.id, SEASON, week, key);
      else if (team === g.away || team === g.home) q.upsertPick.run(u.id, SEASON, week, key, team, Date.now());
      else throw fail(400, 'Pick one of the two teams in this game.');
      return { ok: true };
    },

    // Bring over picks this browser saved before accounts existed (only for games not yet started).
    'POST /api/picks/import': async (req) => {
      const u = currentUser(req); if (!u) throw fail(401, 'Log in first.');
      const { picks } = await readJson(req);
      let imported = 0, skipped = 0;
      for (const [w, entries] of Object.entries(picks || {}).slice(0, 18)) {
        const week = Number(w);
        if (!validWeek(week) || !entries || typeof entries !== 'object') continue;
        if (weekLocked(u.id, week)) { skipped += Object.keys(entries).length; continue; }
        let games; try { games = await espn.getWeek(week); } catch { skipped += Object.keys(entries).length; continue; }
        for (const [key, team] of Object.entries(entries).slice(0, 20)) {
          const g = games.find(x => x.key === key);
          if (!g || isLocked(g) || (team !== g.away && team !== g.home)) { skipped++; continue; }
          imported += Number(q.insertPickIfNew.run(u.id, SEASON, week, key, team, Date.now()).changes);
        }
      }
      return { imported, skipped };
    },

    // Lock in a week's picks for good. Required before exporting the graphic.
    'POST /api/lock': async (req) => {
      const u = currentUser(req); if (!u) throw fail(401, 'Log in first.');
      const { week } = await readJson(req);
      if (!validWeek(week)) throw fail(400, 'Bad week.');
      if (!q.countWeekPicks.get(u.id, SEASON, week).n) throw fail(400, 'Make at least one pick before locking in Week ' + week + '.');
      q.lockWeek.run(u.id, SEASON, week, Date.now());
      return { ok: true, lockedWeeks: lockedWeeks(u.id) };
    },

    // Standings for every account: one week, plus the full season.
    'GET /api/leaderboard': async (req, res, url) => {
      const week = Number(url.searchParams.get('week'));
      if (!validWeek(week)) throw fail(400, 'Week must be 1–18.');
      const users = q.allUsers.all();
      const picks = {}; // userId -> week -> key -> team
      for (const r of q.allPicks.all(SEASON)) ((picks[r.user_id] ??= {})[r.week] ??= {})[r.game_key] = r.team;
      const locks = new Set(q.allLocks.all(SEASON).map(r => r.user_id + ':' + r.week));
      const weeks = [...new Set([week, ...Object.values(picks).flatMap(p => Object.keys(p).map(Number))])];
      const schedules = {};
      await Promise.all(weeks.map(async w => { try { schedules[w] = await espn.getWeek(w); } catch { /* skip weeks ESPN can't serve */ } }));
      const blank = () => ({ correct: 0, wrong: 0, push: 0, pending: 0 });
      const add = (a, b) => { for (const k in b) a[k] += b[k]; };
      const rank = rows => {
        rows.sort((a, b) => b.correct - a.correct || a.wrong - b.wrong || a.username.localeCompare(b.username));
        rows.forEach((r, i) => { r.rank = i && rows[i - 1].correct === r.correct && rows[i - 1].wrong === r.wrong ? rows[i - 1].rank : i + 1; });
        return rows;
      };
      const weekly = [], season = [];
      for (const u of users) {
        const up = picks[u.id] || {};
        const wk = schedules[week] && up[week] ? grade(schedules[week], up[week]) : blank();
        weekly.push({ username: u.username, ...wk, picks: Object.keys(up[week] || {}).length, locked: locks.has(u.id + ':' + week) });
        const tot = blank();
        for (const w of Object.keys(up)) if (schedules[w]) add(tot, grade(schedules[w], up[w]));
        season.push({ username: u.username, ...tot });
      }
      return { week, games: schedules[week]?.length || 0, weekly: rank(weekly), season: rank(season) };
    },

    'GET /api/record': async (req) => {
      const u = currentUser(req); if (!u) throw fail(401, 'Log in first.');
      const byWeek = picksMap(u.id);
      const weeks = {}, season = { correct: 0, wrong: 0, push: 0, pending: 0 };
      await Promise.all(Object.keys(byWeek).map(async w => {
        let games; try { games = await espn.getWeek(Number(w)); } catch { return; }
        const s = grade(games, byWeek[w]);
        weeks[w] = s;
        for (const k in s) season[k] += s[k];
      }));
      return { weeks, season };
    },

    'GET /healthz': async () => 'ok',
  };

  let indexHtml = null;
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const route = routes[req.method + ' ' + url.pathname];
      if (route) {
        const out = await route(req, res, url);
        return Array.isArray(out) ? send(res, 200, out[0], out[1]) : send(res, 200, out);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        indexHtml ??= fs.readFileSync(path.join(clientDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(indexHtml);
      }
      send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong on the server.' });
    }
  };
}

if (require.main === module) {
  const db = openDb();
  const server = http.createServer(createApp({ db, espn: makeEspn() }));
  server.listen(PORT, () => console.log(`Pick'em running on port ${PORT} (database: ${DB_FILE})`));
}

module.exports = { createApp, openDb, makeEspn, parseEvent, grade };
