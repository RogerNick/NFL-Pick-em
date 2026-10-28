# NFL 2026 Pick'em

Pick winners every week, log in to save your picks, and watch your record update automatically as games go final. Exports a broadcast-style PNG of your picks (with ✓ CORRECT / ✗ MISSED once results are in).

- **Accounts:** username + password. Passwords are hashed (scrypt); sessions last 60 days.
- **Results:** schedules and scores come from ESPN's public scoreboard, fetched by the server and cached (refreshes every minute while games are live).
- **Scoring:** a correct pick is a win, a wrong pick is a loss, a tie is a push (not counted in win %). Canceled games don't count.
- **Fair play:** picks lock at each game's kickoff.
- **No dependencies:** runs on Node 24 using only built-in modules. Data lives in one SQLite file.

## Files

```
server.js          the web server and API
client/index.html  the website
package.json       start command + Node version
test.js            self-test (npm test)
```

## Deploy on Railway

1. Push this folder to a GitHub repo (keep `server.js` and `package.json` at the repo root).
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repo.
3. **Add a volume** so accounts and picks survive redeploys: right-click the service (or ⌘K) → **Add Volume**, mount path **`/data`**. The server finds it automatically.
4. Service → **Settings → Networking → Generate Domain**.
5. Optional: under **Variables**, add `SIGNUP_CODE` = any word you choose. Only people with that code can create accounts (good for a private league).

Without the volume, the database is wiped every time you redeploy.

## Run locally

```
node server.js     # http://localhost:3000, data saved in ./data
npm test
```

## Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `SIGNUP_CODE` | none | Invite code required to create an account |
| `SEASON` | `2026` | NFL season to load |
| `DATA_DIR` | Railway volume path, else `./data` | Where the database file is stored |
