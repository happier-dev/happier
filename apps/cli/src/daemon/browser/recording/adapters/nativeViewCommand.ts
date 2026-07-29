import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';

import type { BrowserRecordingNativeViewCaptureCommand } from './nativeView';

/**
 * Reference-only result of one native still-capture over the daemon->native IPC boundary. The
 * native producer (the `desktop_browser_capture_recording_frame` Tauri command) writes the captured
 * PNG to a local file under the recording working directory and returns ONLY a path + metadata —
 * never inline bytes (BRW-15 reference-only invariant). The daemon never sees the pixel buffer.
 */
export type BrowserRecordingNativeViewCaptureTransportResult =
  | Readonly<{
    ok: true;
    /** Local filesystem path the native side wrote the capture to. */
    path: string;
    mimeType: string;
    byteSize: number;
    width?: number;
    height?: number;
    /** Releases the on-disk capture file if the daemon rejects/aborts the recording. */
    cleanup?: () => Promise<void>;
  }>
  | Readonly<{ ok: false; reasonCode: string }>;

/**
 * The desktop-host boundary the `nativeViewCapture` producer talks to. This is the ONLY seam that
 * reaches the native Wry WebView snapshot (`desktop_browser_capture_recording_frame`); everything
 * above it (byte-cap bounding, reference-only artifact shaping) is daemon logic and is unit-tested
 * against a fake transport. Mirrors the `BrowserRecordingCdpScreencastTransport` seam used by the
 * managed-Chromium screencast producer — the concrete IPC wiring is injected by the desktop daemon
 * entrypoint, never opened here.
 */
export type BrowserRecordingNativeViewCaptureTransport = Readonly<{
  captureFrame(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    /** The negotiated recording byte cap. The native side rejects a capture larger than this. */
    maxBytes: number;
  }>): Promise<BrowserRecordingNativeViewCaptureTransportResult>;
}>;

export type BrowserRecordingNativeViewCaptureCommandOptions = Readonly<{
  transport: BrowserRecordingNativeViewCaptureTransport;
}>;

/**
 * Builds the real `nativeViewCapture` producer command from a desktop-host capture transport. This
 * is the "cli adapter that drives" the native `desktop_browser_capture_recording_frame` command:
 * it threads the recording's `maxBytes` cap to the native side, enforces the SAME cap a second time
 * daemon-side as defense-in-depth (a buggy/compromised native side cannot smuggle an oversized
 * artifact past the daemon), and reshapes the native reference into the canonical reference-only
 * `BrowserRecordingNativeViewCaptureResult` consumed by `createBrowserRecordingNativeViewCaptureAdapter`.
 *
 * Bounded per the recording caps (BA-4): an oversized or empty capture is rejected and its on-disk
 * file released via `cleanup`, so nothing unbounded is ever persisted or accumulated in memory.
 */
export function createBrowserRecordingNativeViewCaptureCommand(
  options: BrowserRecordingNativeViewCaptureCommandOptions,
): BrowserRecordingNativeViewCaptureCommand {
  return async ({ recording }) => {
    const maxBytes = recording.maxBytes;

    let result: BrowserRecordingNativeViewCaptureTransportResult;
    try {
      result = await options.transport.captureFrame({ recording, maxBytes });
    } catch {
      return { ok: false, reasonCode: 'native_view_capture_transport_failed' };
    }

    if (!result.ok) {
      return { ok: false, reasonCode: result.reasonCode };
    }

    if (result.byteSize <= 0) {
      await result.cleanup?.().catch(() => undefined);
      return { ok: false, reasonCode: 'native_view_capture_empty' };
    }

    if (result.byteSize > maxBytes) {
      await result.cleanup?.().catch(() => undefined);
      return { ok: false, reasonCode: 'native_view_capture_byte_cap_exceeded' };
    }

    return {
      ok: true,
      source: {
        kind: 'local-file',
        path: result.path,
        mimeType: result.mimeType,
        fileNameHint: 'native-view-recording.png',
      },
      byteSize: result.byteSize,
      ...(result.width !== undefined ? { width: result.width } : {}),
      ...(result.height !== undefined ? { height: result.height } : {}),
      ...(result.cleanup ? { cleanup: result.cleanup } : {}),
    };
  };
}
