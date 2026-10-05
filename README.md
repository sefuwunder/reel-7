# REEL-7 — pocket field recorder

A software homage to Teenage Engineering's TP-7 field recorder: a little
cream-and-orange device in your browser that captures **any audio playing on
your machine**. Bun + zero dependencies.

Run: `bun server.ts` → http://127.0.0.1:3024 (or `REEL7_PORT=xxxx`)

## How to capture system audio

The browser can only hear your system through the screen-share picker.
The honest, browser-native flow:

1. Leave **system** selected (or switch to **mic**).
2. Press **● rec**.
3. A picker appears: choose a **tab**, **window**, or **entire screen**.
4. **Tick “Share system audio”** (Chrome/Edge show this checkbox — without it
   you share the picture but not the voice, and REEL-7 will tell you so).
5. Press **■ stop** — the memo is saved to the list below.

Per-OS notes:

- **macOS**: works in Chrome/Edge. Sharing a *tab* is the most reliable;
  “entire screen” audio needs macOS 13+. If a tab stays silent, make sure
  the tab itself isn't muted.
- **Windows**: tab, window, and screen audio all work in Chrome/Edge.
- **Linux**: works in Chrome; pick the monitor/source in the picker.
- **Mobile**: system capture is not available — the mic is selected
  automatically and works fine.

Keyboard: **R** toggles record, **Space** plays/stops the selected memo.
Double-click a memo name to rename it.

## Architecture

```
index.html   device card: reel SVG, timecode, VU, transport, memos
styles.css   TE design language (cream / ink / orange)
app.js       capture + recorder + playback + IndexedDB (ES module)
lib.js       pure logic: timecode, WAV encoder, naming, mime picking
server.ts    Bun.serve static file server, port 3024
```

- **Capture**: `getDisplayMedia({ video: true, audio: true })` — Chrome only
  offers the audio checkbox when `video: true` is requested, so we ask for
  video and immediately stop those tracks, keeping audio only. Mic path uses
  `getUserMedia({ audio: true })`.
- **Recording**: `MediaRecorder`, preferring `audio/webm;codecs=opus`,
  falling back through `audio/webm`, `audio/mp4`, to the browser default.
- **Level**: `AnalyserNode` on a `MediaStreamSource`, RMS level + peak hold.
- **WAV export**: `decodeAudioData` on the recorded blob, then a hand-written
  16-bit PCM encoder (`encodeWav` in lib.js, ~60 lines) — no libraries.
- **Storage**: IndexedDB (`reel-7` / `memos`), blobs stored natively,
  auto-named `memo 001…`, rename/delete supported.
- **Reel**: SVG with three spokes; spins fast while recording, medium on
  playback, eases out with a wobble on stop. Honors `prefers-reduced-motion`.

Every capability (`mediaDevices`, `MediaRecorder`, `indexedDB`) is checked
before use; every failure surfaces a human sentence, never a stack trace.

## Future hook

Transcription is deliberately out of scope. The natural seam: after
`onRecorderStopped`, send the WAV bytes to a transcription endpoint and
store the text alongside the memo in IndexedDB.
