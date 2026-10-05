/* REEL-7 app.js — pocket field recorder.
 * Capture: getDisplayMedia (system) or getUserMedia (mic) -> MediaRecorder.
 * Pure logic lives in lib.js; everything here is UI + browser APIs, all
 * defensive: every capability is checked before use, every failure gets a
 * human message, never a stack trace.
 */
import {
  formatTimecode,
  formatDuration,
  nextMemoName,
  pickMimeType,
  describeCapabilities,
  encodeWav,
} from "./lib.js";

const $ = (id) => document.getElementById(id);

/* ---------------- state ---------------- */
const S = {
  source: "system",
  stream: null,
  recorder: null,
  chunks: [],
  mime: "",
  recording: false,
  recStart: 0,
  audioCtx: null,
  analyser: null,
  vuData: null,
  vuRaf: 0,
  clockRaf: 0,
  peak: 0,
  playingId: null,
  audioEl: null,
  audioUrl: null,
  selectedId: null,
  memos: [],
  clickOn: true,
  clickCtx: null,
};

/* ---------------- toast + click ---------------- */
let toastTimer = 0;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 7000);
}

function click() {
  if (!S.clickOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    S.clickCtx = S.clickCtx || new AC();
    const ctx = S.clickCtx;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = 1700;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.07);
  } catch {
    /* silence is acceptable */
  }
}

/* ---------------- reel + timecode ---------------- */
function setReel(mode) {
  const reel = $("reel");
  reel.classList.remove("spin-fast", "spin-med", "wobble");
  if (mode === "rec") reel.classList.add("spin-fast");
  else if (mode === "play") reel.classList.add("spin-med");
  else if (mode === "wobble") {
    // force reflow so the wobble replays even back-to-back
    void reel.offsetWidth;
    reel.classList.add("wobble");
  }
}

function startClock() {
  stopClock();
  const loop = () => {
    S.clockRaf = requestAnimationFrame(loop);
    let ms = 0;
    if (S.recording) ms = performance.now() - S.recStart;
    else if (S.audioEl && S.playingId != null) ms = S.audioEl.currentTime * 1000;
    $("timecode").textContent = formatTimecode(ms);
  };
  loop();
}
function stopClock() {
  cancelAnimationFrame(S.clockRaf);
  S.clockRaf = 0;
}

/* ---------------- VU meter ---------------- */
function startVu() {
  stopVu();
  if (!S.analyser) return;
  const fill = $("vuFill");
  const peakEl = $("vuPeak");
  S.peak = 0;
  const loop = () => {
    S.vuRaf = requestAnimationFrame(loop);
    S.analyser.getByteTimeDomainData(S.vuData);
    let sum = 0;
    let pk = 0;
    for (let i = 0; i < S.vuData.length; i++) {
      const v = (S.vuData[i] - 128) / 128;
      sum += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
    }
    const level = Math.min(1, Math.sqrt(sum / S.vuData.length) * 2.5);
    S.peak = Math.max(pk, S.peak * 0.985);
    fill.style.width = (level * 100).toFixed(1) + "%";
    fill.classList.toggle("hot", level > 0.85);
    peakEl.style.left = (Math.min(1, S.peak) * 100).toFixed(1) + "%";
  };
  loop();
}
function stopVu() {
  cancelAnimationFrame(S.vuRaf);
  S.vuRaf = 0;
  $("vuFill").style.width = "0%";
  $("vuPeak").style.left = "0%";
}

/* ---------------- audio plumbing ---------------- */
function ensureCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("no webaudio");
  if (!S.audioCtx) S.audioCtx = new AC();
  if (S.audioCtx.state === "suspended") S.audioCtx.resume().catch(() => {});
  return S.audioCtx;
}

function wireAnalyser(stream) {
  S.analyser = null;
  try {
    const ctx = ensureCtx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    S.analyser = an;
    S.vuData = new Uint8Array(an.fftSize);
  } catch {
    S.analyser = null;
  }
}

function teardownStream() {
  if (S.stream) {
    S.stream.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* noop */ }
    });
    S.stream = null;
  }
  S.analyser = null;
}

function setSourceState(text, cls) {
  const el = $("sourceState");
  el.textContent = text;
  el.classList.toggle("armed", cls === "armed");
  el.classList.toggle("live", cls === "live");
}

function updateTransport() {
  const armed = !!S.stream && S.stream.getAudioTracks().length > 0;
  $("recBtn").disabled = !armed || S.recording;
  $("recBtn").classList.toggle("armed", S.recording);
  $("stopBtn").disabled = !S.recording;
  $("playBtn").disabled = S.memos.length === 0 || S.recording;
}

/* ---------------- capture: arm a source ---------------- */
function updateSourceUI() {
  $("sysBtn").classList.toggle("active", S.source === "system");
  $("micBtn").classList.toggle("active", S.source === "mic");
  $("sysBtn").setAttribute("aria-pressed", String(S.source === "system"));
  $("micBtn").setAttribute("aria-pressed", String(S.source === "mic"));
}

async function armSource(kind) {
  stopPlayback();
  teardownStream();
  S.source = kind;
  updateSourceUI();
  setSourceState("listening…");
  try {
    let stream;
    if (kind === "system") {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error("system capture needs desktop chrome or edge — the mic still works.");
      }
      // Chrome only offers the audio checkbox when video:true is requested.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      // We only want ears, not eyes: drop the video track immediately.
      stream.getVideoTracks().forEach((t) => {
        try { t.stop(); } catch { /* noop */ }
      });
    } else {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("no microphone path in this browser.");
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* noop */ }
      });
      throw new Error(
        kind === "system"
          ? "you shared the picture but not the voice — tick “share system audio” and try again."
          : "the mic gave no audio track — check permissions and try again."
      );
    }
    S.stream = stream;
    wireAnalyser(stream);
    stream.getAudioTracks()[0].addEventListener("ended", () => {
      // user revoked sharing via the browser chrome
      if (S.recording) stopRecording();
      teardownStream();
      setSourceState("source ended — arm again");
      updateTransport();
    });
    setSourceState(kind === "system" ? "system armed — press ●" : "mic armed — press ●", "armed");
  } catch (err) {
    teardownStream();
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      toast("no ears — grant the tab your system’s voice and try again.");
    } else {
      toast((err && err.message) || "the source stayed silent — try again.");
    }
    setSourceState("not armed");
  }
  updateTransport();
}

/* ---------------- recording engine ---------------- */
function startRecording() {
  if (S.recording) return;
  if (!S.stream || S.stream.getAudioTracks().length === 0) {
    toast("arm a source first — system or mic.");
    return;
  }
  if (typeof MediaRecorder === "undefined") {
    toast("this browser cannot record audio.");
    return;
  }
  const mime = pickMimeType((m) => {
    try {
      return MediaRecorder.isTypeSupported(m);
    } catch {
      return false;
    }
  });
  let rec;
  try {
    rec = mime ? new MediaRecorder(S.stream, { mimeType: mime }) : new MediaRecorder(S.stream);
  } catch {
    toast("the recorder refused to start — try the other source.");
    return;
  }
  S.chunks = [];
  S.mime = rec.mimeType || mime;
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) S.chunks.push(e.data);
  };
  rec.onstop = onRecorderStopped;
  rec.onerror = () => toast("the tape jammed mid-take — the take kept what it could.");
  try {
    rec.start(250);
  } catch {
    toast("the recorder refused to start.");
    return;
  }
  S.recorder = rec;
  S.recording = true;
  S.recStart = performance.now();
  click();
  setReel("rec");
  $("recDot").hidden = false;
  document.querySelector(".device").classList.add("recording");
  setSourceState("● recording", "live");
  startClock();
  startVu();
  updateTransport();
}

function stopRecording() {
  if (!S.recording || !S.recorder) return;
  try {
    S.recorder.stop();
  } catch {
    /* onstop will still fire in most cases */
  }
}

function onRecorderStopped() {
  S.recording = false;
  S.recorder = null;
  stopClock();
  stopVu();
  click();
  setReel("wobble");
  setTimeout(() => {
    if (!S.recording && S.playingId == null) setReel("idle");
  }, 750);
  $("recDot").hidden = true;
  document.querySelector(".device").classList.remove("recording");

  const blob = new Blob(S.chunks, { type: S.mime || "audio/webm" });
  const durationMs = performance.now() - S.recStart;
  S.chunks = [];
  if (!blob.size) {
    toast("the take came back empty — nothing was captured.");
    setSourceState(S.stream ? "armed — press ●" : "not armed", S.stream ? "armed" : "");
    updateTransport();
    return;
  }
  saveMemo({ blob, durationMs, mimeType: blob.type || S.mime || "audio/webm" })
    .then((memo) => {
      S.selectedId = memo.id;
      toast(`${memo.name} saved — ${formatDuration(memo.durationMs)}.`);
      return refreshMemos();
    })
    .then(() => {
      setSourceState("armed — press ●", "armed");
      updateTransport();
    })
    .catch(() => {
      toast("the take is safe in memory but would not save — storage unavailable.");
      setSourceState("armed — press ●", "armed");
      updateTransport();
    });
}

/* ---------------- indexeddb memos ---------------- */
const DB_NAME = "reel-7";
const DB_STORE = "memos";
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("no indexeddb"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("db open failed"));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("db request failed"));
  });
}

function withStore(mode, fn) {
  return openDb().then((db) => {
    const tx = db.transaction(DB_STORE, mode);
    return fn(tx.objectStore(DB_STORE), reqToPromise);
  });
}

function saveMemo({ blob, durationMs, mimeType }) {
  return withStore("readwrite", async (store, p) => {
    const all = await p(store.getAll());
    const memo = {
      name: nextMemoName((all || []).map((m) => m.name)),
      createdAt: Date.now(),
      durationMs: Math.round(durationMs),
      mimeType,
      blob,
    };
    const id = await p(store.add(memo));
    return { ...memo, id };
  });
}

function loadMemos() {
  return withStore("readonly", (store, p) => p(store.getAll()))
    .then((all) => (all || []).sort((a, b) => b.createdAt - a.createdAt))
    .catch(() => []);
}

function deleteMemo(id) {
  return withStore("readwrite", (store, p) => p(store.delete(id)));
}

function renameMemo(id, name) {
  return withStore("readwrite", async (store, p) => {
    const memo = await p(store.get(id));
    if (!memo) throw new Error("memo is gone");
    memo.name = name;
    await p(store.put(memo));
    return memo;
  });
}

function refreshMemos() {
  return loadMemos().then((memos) => {
    S.memos = memos;
    renderMemos();
    updateTransport();
  });
}

/* ---------------- memo list ---------------- */
function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function renderMemos() {
  const list = $("memoList");
  list.innerHTML = "";
  $("emptyMemos").hidden = S.memos.length > 0;
  $("memoCount").textContent = S.memos.length ? `${S.memos.length}` : "";
  for (const memo of S.memos) {
    const li = document.createElement("li");
    li.className = "memo" + (memo.id === S.selectedId ? " selected" : "") + (memo.id === S.playingId ? " playing" : "");
    li.dataset.id = memo.id;

    const play = document.createElement("button");
    play.className = "mplay";
    play.textContent = memo.id === S.playingId ? "❚❚" : "▶";
    play.setAttribute("aria-label", `play ${memo.name}`);
    play.addEventListener("click", () => {
      if (S.playingId === memo.id) stopPlayback();
      else playMemo(memo.id);
    });

    const mid = document.createElement("div");
    const name = document.createElement("div");
    name.className = "mname";
    name.textContent = memo.name;
    name.title = "double-click to rename";
    name.addEventListener("dblclick", () => startRename(li, memo));
    const meta = document.createElement("div");
    meta.className = "mmeta";
    meta.textContent = `${formatDuration(memo.durationMs)} · ${fmtDate(memo.createdAt)}`;
    mid.appendChild(name);
    mid.appendChild(meta);

    const acts = document.createElement("div");
    acts.className = "macts";
    const mkBtn = (label, title, fn, cls) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        fn();
      });
      acts.appendChild(b);
    };
    mkBtn("webm", "download original recording", () => downloadWebm(memo));
    mkBtn("wav", "download as 16-bit wav", () => downloadWav(memo));
    mkBtn("del", "delete memo", () => {
      if (window.confirm(`delete “${memo.name}”?`)) {
        if (S.playingId === memo.id) stopPlayback();
        deleteMemo(memo.id)
          .then(() => {
            if (S.selectedId === memo.id) S.selectedId = null;
            return refreshMemos();
          })
          .catch(() => toast("the memo would not delete."));
      }
    }, "del");

    li.appendChild(play);
    li.appendChild(mid);
    li.appendChild(acts);
    li.addEventListener("click", () => {
      S.selectedId = memo.id;
      renderMemos();
    });
    list.appendChild(li);
  }
  const totalMs = S.memos.reduce((a, m) => a + (m.durationMs || 0), 0);
  $("storageReadout").textContent =
    `${S.memos.length} memo${S.memos.length === 1 ? "" : "s"} · ${formatDuration(totalMs)} total`;
}

function startRename(li, memo) {
  const nameEl = li.querySelector(".mname");
  const input = document.createElement("input");
  input.value = memo.name;
  input.setAttribute("aria-label", "rename memo");
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v && v !== memo.name) {
      renameMemo(memo.id, v)
        .then(() => refreshMemos())
        .catch(() => {
          toast("the rename did not stick.");
          refreshMemos();
        });
    } else {
      renderMemos();
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

/* ---------------- playback ---------------- */
function stopPlayback() {
  if (S.audioEl) {
    try { S.audioEl.pause(); } catch { /* noop */ }
    S.audioEl = null;
  }
  if (S.audioUrl) {
    try { URL.revokeObjectURL(S.audioUrl); } catch { /* noop */ }
    S.audioUrl = null;
  }
  const wasPlaying = S.playingId != null;
  S.playingId = null;
  if (wasPlaying) {
    stopClock();
    if (!S.recording) setReel("idle");
    renderMemos();
    updateTransport();
  }
}

function playMemo(id) {
  if (S.recording) return;
  stopPlayback();
  const memo = S.memos.find((m) => m.id === id);
  if (!memo || !memo.blob) {
    toast("that memo has no audio to play.");
    return;
  }
  try {
    S.audioUrl = URL.createObjectURL(memo.blob);
    const el = new Audio(S.audioUrl);
    S.audioEl = el;
    S.playingId = id;
    S.selectedId = id;
    el.addEventListener("ended", () => stopPlayback());
    el.addEventListener("error", () => {
      toast("playback stumbled — the file may be corrupt.");
      stopPlayback();
    });
    const p = el.play();
    if (p && p.catch) p.catch(() => toast("playback refused to start."));
    click();
    setReel("play");
    startClock();
    renderMemos();
    updateTransport();
  } catch {
    toast("playback refused to start.");
    stopPlayback();
  }
}

function togglePlaySelected() {
  if (S.playingId != null) {
    stopPlayback();
    return;
  }
  const id = S.selectedId != null ? S.selectedId : S.memos.length ? S.memos[0].id : null;
  if (id != null) playMemo(id);
}

/* ---------------- downloads ---------------- */
function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch { /* noop */ }
    }, 5000);
  } catch {
    toast("the download would not start.");
  }
}

function safeName(name) {
  return String(name).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "memo";
}

function downloadWebm(memo) {
  const ext = (memo.mimeType || "").includes("mp4") ? "m4a" : "webm";
  downloadBlob(memo.blob, `${safeName(memo.name)}.${ext}`);
}

async function downloadWav(memo) {
  toast("baking wav…");
  try {
    const ctx = ensureCtx();
    const ab = await memo.blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(ab.slice(0));
    const channels = [];
    for (let c = 0; c < audioBuf.numberOfChannels; c++) {
      channels.push(audioBuf.getChannelData(c).slice(0));
    }
    const wav = encodeWav({ sampleRate: audioBuf.sampleRate, channels });
    downloadBlob(new Blob([wav], { type: "audio/wav" }), `${safeName(memo.name)}.wav`);
    toast("wav ready.");
  } catch {
    toast("the wav bake failed — the webm download still works.");
  }
}

/* ---------------- keyboard ---------------- */
window.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName ? e.target.tagName : "").toLowerCase();
  if (tag === "input" || tag === "textarea" || (e.target && e.target.isContentEditable)) return;
  if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    if (S.recording) stopRecording();
    else startRecording();
  } else if (e.code === "Space") {
    e.preventDefault();
    togglePlaySelected();
  }
});

/* ---------------- boot ---------------- */
function boot() {
  const caps = {
    hasMediaDevices: !!(navigator.mediaDevices),
    hasDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
    hasUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
    hasIndexedDB: !!window.indexedDB,
  };
  const rep = describeCapabilities(caps);
  if (!rep.ok) toast(rep.issues.join(" "));

  if (!caps.hasDisplayMedia && caps.hasUserMedia) {
    // default to the source that can actually work here
    S.source = "mic";
    toast("system capture needs desktop chrome or edge — mic selected instead.");
  }
  if (!caps.hasDisplayMedia) $("sysBtn").disabled = true;
  if (!caps.hasUserMedia) $("micBtn").disabled = true;
  updateSourceUI();

  if (!window.localStorage.getItem("reel7.onboarded")) {
    $("onboard").hidden = false;
  }
  $("onboardOk").addEventListener("click", () => {
    $("onboard").hidden = true;
    try {
      window.localStorage.setItem("reel7.onboarded", "1");
    } catch { /* private mode etc. */ }
  });

  $("sysBtn").addEventListener("click", () => armSource("system"));
  $("micBtn").addEventListener("click", () => armSource("mic"));
  $("recBtn").addEventListener("click", () => {
    if (S.recording) stopRecording();
    else if (!S.stream) armSource(S.source).then(() => startRecording());
    else startRecording();
  });
  $("stopBtn").addEventListener("click", stopRecording);
  $("playBtn").addEventListener("click", togglePlaySelected);
  $("sndBtn").addEventListener("click", () => {
    S.clickOn = !S.clickOn;
    $("sndBtn").textContent = S.clickOn ? "click · on" : "click · off";
  });

  window.addEventListener("beforeunload", () => {
    if (S.recording && S.recorder) {
      try { S.recorder.stop(); } catch { /* noop */ }
    }
    teardownStream();
  });

  refreshMemos().then(() => updateTransport());
  updateTransport();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
