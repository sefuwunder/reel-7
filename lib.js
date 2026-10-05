/* REEL-7 lib.js — pure logic, no browser APIs.
 * Imported by app.js (ES module) and by tests. Everything here is
 * deterministic and side-effect free.
 */

/** Format milliseconds as TE-style timecode MM:SS.cs (centiseconds). */
export function formatTimecode(ms) {
  const t = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(t / 60000);
  const seconds = Math.floor((t % 60000) / 1000);
  const centis = Math.floor((t % 1000) / 10);
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centis, 2)}`;
}

/** Format milliseconds as a human memo duration M:SS. */
export function formatDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Next auto-name in the "memo 001" sequence.
 * Ignores names that don't match; case-insensitive; fills from max+1.
 */
export function nextMemoName(existingNames) {
  let max = 0;
  for (const n of existingNames || []) {
    const m = /^memo (\d+)$/i.exec(String(n).trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `memo ${String(max + 1).padStart(3, "0")}`;
}

/** Mime types to try, in preference order. "" = browser default. */
export const MIME_PREFS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

/**
 * Pick the first supported mime type. isSupported: (mime) => boolean.
 * Returns "" when nothing matches (MediaRecorder default).
 */
export function pickMimeType(isSupported) {
  for (const m of MIME_PREFS) {
    try {
      if (isSupported(m)) return m;
    } catch {
      /* try the next one */
    }
  }
  return "";
}

/**
 * Human-readable capability report. caps: { hasMediaDevices, hasDisplayMedia,
 * hasUserMedia, hasMediaRecorder, hasIndexedDB }. Never throws.
 */
export function describeCapabilities(caps) {
  const c = caps || {};
  const issues = [];
  if (!c.hasMediaDevices) {
    issues.push("no ears at all — this browser exposes no audio capture.");
  } else {
    if (!c.hasDisplayMedia)
      issues.push("system capture needs desktop chrome or edge — the mic still works.");
    if (!c.hasUserMedia) issues.push("no microphone path available.");
  }
  if (!c.hasMediaRecorder) issues.push("this browser cannot record audio.");
  if (!c.hasIndexedDB) issues.push("memos will not survive a reload — storage unavailable.");
  return { ok: issues.length === 0, issues };
}

/** Read an ASCII string from a DataView at offset. */
function readAscii(view, offset, length) {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * Encode 16-bit PCM WAV. channels: Float32Array[] (all same length, -1..1).
 * Returns a Uint8Array with a full 44-byte RIFF header.
 */
export function encodeWav({ sampleRate, channels }) {
  const numChannels = channels.length;
  const numSamples = numChannels > 0 ? channels[0].length : 0;
  const blockAlign = numChannels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      offset += 2;
    }
  }
  return new Uint8Array(buffer);
}

/** Parse a WAV header back out (for tests / verification). */
export function parseWavHeader(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    riff: readAscii(view, 0, 4),
    wave: readAscii(view, 8, 4),
    fmt: readAscii(view, 12, 4),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataId: readAscii(view, 36, 4),
    dataSize: view.getUint32(40, true),
  };
}

/** Decode 16-bit PCM samples from a WAV Uint8Array (for round-trip tests). */
export function decodeWavSamples(u8) {
  const h = parseWavHeader(u8);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const frames = h.dataSize / h.blockAlign;
  const channels = [];
  for (let ch = 0; ch < h.numChannels; ch++) channels.push(new Float32Array(frames));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < h.numChannels; ch++) {
      channels[ch][i] = view.getInt16(offset, true) / 0x8000;
      offset += 2;
    }
  }
  return { header: h, channels };
}
