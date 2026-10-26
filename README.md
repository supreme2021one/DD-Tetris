# DD Tetris

A small, browser-playable falling-block puzzle prototype with solo, same-keyboard, and private two-player room-code play.

## Run it

1. Install Node.js 18 or newer if it is not already installed.
2. Open a terminal in this folder.
3. Run `node server.js`.
4. Open [http://localhost:8787](http://localhost:8787).

There are no npm dependencies to install.

## Mobile play

DD Tetris is an installable web app. Open the hosted HTTPS address on a phone and use the browser's **Install app** option (Android/Chrome) or **Add to Home Screen** (iPhone/Safari). The game has portrait-friendly boards and hold-to-repeat touch controls. After the first online load, the app shell is cached for offline solo and local play; online rooms and shared high scores still need the server and internet connection.

## Modes

- **Solo run:** play for a high score.
- **Local duel:** two people play on one keyboard.
- **Online party:** create a private room, share the six-character code, and have one friend join. Clear multiple rows to send garbage lines to the other player.
- In either duel mode, a DD Tetris sends one marked garbage line to the opponent. If they clear that row within 20 seconds, one penalty line is sent back.
- **HI-SCORE:** enter a player name and scores are submitted when a run ends. The top ten is shared by everyone using the same game server and stored in `leaderboard.json`.

The online mode and shared leaderboard need the Node server running. On the same Wi-Fi, another player can open this computer's local network address on port `8787`. For worldwide play, host this Node app on a public service that supports WebSocket upgrades and HTTPS/WSS, and use persistent disk storage so `leaderboard.json` survives restarts. The game automatically uses secure WebSockets when served over HTTPS.

### Free Render host

The included `render.yaml` is ready to deploy as a Render Free Web Service. Push this project to a GitHub repository, then in Render choose **New > Blueprint** and connect that repository. Render reads the Blueprint, builds with `npm install`, starts with `npm start`, and checks `/healthz`. When deployment finishes, copy the service's `https://...onrender.com` address into the server field on both APKs. Free services can sleep after inactivity and may take about a minute to wake; rooms are in memory, and the file-based leaderboard can reset after a restart.

## Controls

### Solo and online

| Action | Keys |
|---|---|
| Move | ← / → |
| Rotate | ↑ or X |
| Rotate counter-clockwise | Z |
| Soft drop | ↓ |
| Hard drop | Space |
| Hold piece | C |
| Pause | Escape or Pause button |

On phones, solo play hides the site header and uses an immersive full-screen board with a floating touch deck. Online play uses one phone per player and each phone shows its own board. Local duel remains available on larger screens. The Android APK hides the system bars during a game and restores them at the menu.

### Local duel

| Action | Player 1 | Player 2 |
|---|---|---|
| Move | A / D | ← / → |
| Rotate | W (counter-clockwise: E) | ↑ (counter-clockwise: .) |
| Soft drop | S | ↓ |
| Hard drop | Left Shift | Enter |
| Hold | Q | / |

## Project files

- `index.html` — screens and game layout
- `styles.css` — responsive visual design
- `app.js` — falling-block rules, controls, rendering, and multiplayer client
- `server.js` — static web server and room-code WebSocket relay
- `package.json` — one-command start script

## Prototype limits

- Online rooms support two players and exist only in server memory. They disappear when both players leave or the server restarts.
- The server relays game state; it does not validate scores or prevent cheating. This is a friendly prototype, not ranked competitive play.
- The leaderboard is a casual shared high-score board. It has no player accounts or score verification, so a public deployment should not be treated as cheat-proof.
- There are no accounts, public chat, matchmaking, persistent scores, or monetization.
- This is an original falling-block prototype, not an official Tetris product.
