/**
 * Select a recording container supported by the current browser.
 * Safari/iOS commonly supports AAC in an MP4 container; Chromium browsers
 * generally prefer Opus in WebM. Return null to let MediaRecorder choose its
 * own default when it does not expose any of these explicit MIME types.
 */
export function getPreferredRecordingMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string | null {
  const candidates = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
  ];
  return candidates.find((mimeType) => {
    try {
      return isTypeSupported(mimeType);
    } catch {
      return false;
    }
  }) ?? null;
}
