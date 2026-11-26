import { describe, expect, test } from "bun:test";
import { getPreferredRecordingMimeType } from "./recording";

describe("recording MIME selection", () => {
  test("prefers MP4/AAC when supported by Safari and iOS", () => {
    const supported = new Set(["audio/mp4", "audio/webm;codecs=opus"]);
    expect(getPreferredRecordingMimeType((type) => supported.has(type))).toBe("audio/mp4");
  });

  test("falls back to Opus WebM when MP4 is unavailable", () => {
    const supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
    expect(getPreferredRecordingMimeType((type) => supported.has(type))).toBe("audio/webm;codecs=opus");
  });

  test("falls back to plain WebM when Opus is unavailable", () => {
    expect(getPreferredRecordingMimeType((type) => type === "audio/webm")).toBe("audio/webm");
  });

  test("returns null when browser should choose its default", () => {
    expect(getPreferredRecordingMimeType(() => false)).toBeNull();
  });

  test("treats a browser support-check exception as unsupported", () => {
    expect(getPreferredRecordingMimeType(() => { throw new Error("unsupported"); })).toBeNull();
  });
});
