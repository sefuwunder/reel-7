import { describe, test, expect } from "bun:test";
import {
  formatTimecode,
  formatDuration,
  nextMemoName,
  pickMimeType,
  describeCapabilities,
  encodeWav,
  parseWavHeader,
  decodeWavSamples,
} from "../lib.js";

describe("formatTimecode", () => {
  test("zero", () => expect(formatTimecode(0)).toBe("00:00.00"));
  test("sub-second", () => expect(formatTimecode(999)).toBe("00:00.99"));
  test("one second", () => expect(formatTimecode(1000)).toBe("00:01.00"));
  test("61500 -> 01:01.50", () => expect(formatTimecode(61500)).toBe("01:01.50"));
  test("just under a minute", () => expect(formatTimecode(59999)).toBe("00:59.99"));
  test("one hour", () => expect(formatTimecode(3600000)).toBe("60:00.00"));
  test("fractional input floors", () => expect(formatTimecode(1234.9)).toBe("00:01.23"));
  test("negative clamps to zero", () => expect(formatTimecode(-500)).toBe("00:00.00"));
});

describe("formatDuration", () => {
  test("zero", () => expect(formatDuration(0)).toBe("0:00"));
  test("3 seconds", () => expect(formatDuration(3000)).toBe("0:03"));
  test("61 seconds", () => expect(formatDuration(61000)).toBe("1:01"));
  test("10 minutes", () => expect(formatDuration(600000)).toBe("10:00"));
  test("rounds half up", () => expect(formatDuration(1500)).toBe("0:02"));
});

describe("nextMemoName", () => {
  test("empty list starts at 001", () => expect(nextMemoName([])).toBe("memo 001"));
  test("increments", () => expect(nextMemoName(["memo 001"])).toBe("memo 002"));
  test("fills from max, not count", () =>
    expect(nextMemoName(["memo 001", "memo 003"])).toBe("memo 004"));
  test("ignores non-matching names", () =>
    expect(nextMemoName(["interview", "memo 002"])).toBe("memo 003"));
  test("case-insensitive", () => expect(nextMemoName(["Memo 007"])).toBe("memo 008"));
  test("rolls past 099", () => expect(nextMemoName(["memo 099"])).toBe("memo 100"));
  test("undefined input", () => expect(nextMemoName(undefined)).toBe("memo 001"));
});

describe("pickMimeType", () => {
  test("prefers opus", () =>
    expect(pickMimeType((m) => m === "audio/webm;codecs=opus")).toBe("audio/webm;codecs=opus"));
  test("falls back to webm", () =>
    expect(pickMimeType((m) => m === "audio/webm")).toBe("audio/webm"));
  test("falls back to mp4", () =>
    expect(pickMimeType((m) => m === "audio/mp4")).toBe("audio/mp4"));
  test("empty string when nothing supported", () =>
    expect(pickMimeType(() => false)).toBe(""));
  test("survives throwing checker", () =>
    expect(pickMimeType(() => { throw new Error("nope"); })).toBe(""));
  test("skips throwing entries", () =>
    expect(
      pickMimeType((m) => {
        if (m === "audio/webm;codecs=opus") throw new Error("nope");
        return m === "audio/webm";
      })
    ).toBe("audio/webm"));
});

describe("describeCapabilities", () => {
  const full = {
    hasMediaDevices: true, hasDisplayMedia: true, hasUserMedia: true,
    hasMediaRecorder: true, hasIndexedDB: true,
  };
  test("all present is ok", () => {
    const r = describeCapabilities(full);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });
  test("no media devices", () => {
    const r = describeCapabilities({ ...full, hasMediaDevices: false });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/no ears/i);
  });
  test("no display media warns but mic path noted", () => {
    const r = describeCapabilities({ ...full, hasDisplayMedia: false });
    expect(r.ok).toBe(false);
    expect(r.issues.join(" ")).toMatch(/chrome or edge/i);
  });
  test("no media recorder", () => {
    const r = describeCapabilities({ ...full, hasMediaRecorder: false });
    expect(r.issues.join(" ")).toMatch(/cannot record/i);
  });
  test("no indexeddb", () => {
    const r = describeCapabilities({ ...full, hasIndexedDB: false });
    expect(r.issues.join(" ")).toMatch(/will not survive/i);
  });
  test("undefined input never throws", () => {
    const r = describeCapabilities(undefined);
    expect(r.ok).toBe(false);
  });
});

function sineWave(freq, sampleRate, seconds, amp = 0.8) {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe("encodeWav", () => {
  test("header magic", () => {
    const wav = encodeWav({ sampleRate: 44100, channels: [new Float32Array(10)] });
    const h = parseWavHeader(wav);
    expect(h.riff).toBe("RIFF");
    expect(h.wave).toBe("WAVE");
    expect(h.fmt).toBe("fmt ");
    expect(h.dataId).toBe("data");
  });
  test("fmt fields for mono 44.1k", () => {
    const wav = encodeWav({ sampleRate: 44100, channels: [new Float32Array(100)] });
    const h = parseWavHeader(wav);
    expect(h.audioFormat).toBe(1);
    expect(h.numChannels).toBe(1);
    expect(h.sampleRate).toBe(44100);
    expect(h.bitsPerSample).toBe(16);
    expect(h.blockAlign).toBe(2);
    expect(h.byteRate).toBe(88200);
    expect(h.dataSize).toBe(200);
    expect(wav.length).toBe(44 + 200);
  });
  test("mono round-trip preserves samples", () => {
    const src = sineWave(440, 8000, 0.25);
    const wav = encodeWav({ sampleRate: 8000, channels: [src] });
    const { channels } = decodeWavSamples(wav);
    expect(channels.length).toBe(1);
    expect(channels[0].length).toBe(src.length);
    for (let i = 0; i < src.length; i += 7) {
      expect(Math.abs(channels[0][i] - src[i])).toBeLessThan(1.5 / 32768);
    }
  });
  test("stereo interleaves L/R correctly", () => {
    const left = sineWave(440, 8000, 0.1);
    const right = sineWave(880, 8000, 0.1);
    const wav = encodeWav({ sampleRate: 8000, channels: [left, right] });
    const { header, channels } = decodeWavSamples(wav);
    expect(header.numChannels).toBe(2);
    expect(header.blockAlign).toBe(4);
    for (let i = 0; i < left.length; i += 11) {
      expect(Math.abs(channels[0][i] - left[i])).toBeLessThan(1.5 / 32768);
      expect(Math.abs(channels[1][i] - right[i])).toBeLessThan(1.5 / 32768);
    }
  });
  test("clips out-of-range samples", () => {
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array([2, -2, 0.5])] });
    const { channels } = decodeWavSamples(wav);
    expect(channels[0][0]).toBeCloseTo(1, 4);
    expect(channels[0][1]).toBeCloseTo(-1, 4);
    expect(channels[0][2]).toBeCloseTo(0.5, 4);
  });
  test("empty channels produce valid header with zero data", () => {
    const wav = encodeWav({ sampleRate: 48000, channels: [] });
    const h = parseWavHeader(wav);
    expect(h.dataSize).toBe(0);
    expect(wav.length).toBe(44);
  });
  test("silence encodes to zeros", () => {
    const wav = encodeWav({ sampleRate: 8000, channels: [new Float32Array(16)] });
    const { channels } = decodeWavSamples(wav);
    expect(channels[0].every((v) => v === 0)).toBe(true);
  });
});
