import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserRecordingNativeViewCaptureTransport } from './nativeViewCommand';

/**
 * Reference-only request the daemon hands the canonical desktop invoke path (the
 * `desktop_browser_capture_recording_frame` Tauri command, A2-registered). The daemon owns the
 * root-relative artifact path and the negotiated `maxBytes` cap; the native side resolves that
 * artifact under its app-owned recording root and returns ONLY a reference + metadata (BRW-15
 * reference-only invariant) — the pixel buffer never crosses back to the daemon.
 */
export type DesktopBrowserRecordingFrameCaptureRequest = Readonly<{
  browserSessionId: string;
  viewId: string;
  navigationGeneration: number;
  captureRequestId: string;
  /** Recording-root-relative artifact path. Never an absolute caller-controlled filesystem path. */
  outputPath: string;
  /** Recording byte cap. The native side rejects a capture larger than this. */
  maxBytes: number;
}>;

/**
 * Normalized result of the canonical desktop recording-frame invoke. This is the daemon-facing shape
 * the desktop entrypoint adapts the real `DesktopBrowserCaptureRecordingFrameResult` IPC payload onto
 * — keeping the daemon transport free of any `apps/ui`/Tauri coupling (one canonical seam, no parallel
 * native binding).
 */
export type DesktopBrowserRecordingFrameCaptureResult =
  | Readonly<{
    ok: true;
    frame: Readonly<{
      mimeType: string;
      width: number;
      height: number;
      sizeBytes: number;
      /** Absolute path the native side actually wrote under its app-owned recording root. */
      path: string;
    }>;
  }>
  | Readonly<{ ok: false; errorCode: string }>;

/**
 * The canonical desktop invoke path for a single recording-frame capture. Supplied by the desktop
 * daemon entrypoint, it routes through the SAME `invokeTauri` channel the desktop browser engine uses
 * for navigation/snapshot (A2-registered) — never a second native binding. Absent on headless/non-
 * desktop hosts, so the desktop recording cell stays honestly fail-closed there.
 */
export type DesktopBrowserRecordingFrameCaptureInvoke = (
  request: DesktopBrowserRecordingFrameCaptureRequest,
) => Promise<DesktopBrowserRecordingFrameCaptureResult>;

export type DesktopBrowserRecordingNativeViewCaptureTransportOptions = Readonly<{
  invokeRecordingFrameCapture: DesktopBrowserRecordingFrameCaptureInvoke;
  /** Recording working directory; retained for daemon-side setup and test injection. */
  workingDirectory: string;
  /** Override the output directory (tests). */
  outputDirectory?: string;
  /** Injectable unique-id source (tests); defaults to `crypto.randomUUID`. */
  randomId?: () => string;
  /** Injectable directory-ensure seam (tests); defaults to `fs.mkdir(..., { recursive: true })`. */
  ensureDirectory?: (directory: string) => Promise<void>;
  /** Injectable file-delete seam (tests); defaults to `fs.rm(..., { force: true })`. */
  deleteFile?: (path: string) => Promise<void>;
}>;

function defaultEnsureDirectory(directory: string): Promise<void> {
  return mkdir(directory, { recursive: true }).then(() => undefined);
}

function defaultDeleteFile(path: string): Promise<void> {
  return rm(path, { force: true });
}

/**
 * Builds the concrete desktop-host `nativeViewCapture` transport (the missing daemon→native (Wry) IPC
 * producer). It is the seam injected by the desktop daemon entrypoint into
 * `createBrowserRecordingNativeViewCaptureCommand`: it derives a root-relative artifact id, threads
 * the recording's negotiated `maxBytes` cap to the native side, and reshapes the native reference
 * into the canonical reference-only `BrowserRecordingNativeViewCaptureTransportResult`. The native
 * side owns root containment, byte caps, and atomic writes; the daemon only deletes the absolute path
 * returned after a successful capture.
 */
export function createDesktopBrowserRecordingNativeViewCaptureTransport(
  options: DesktopBrowserRecordingNativeViewCaptureTransportOptions,
): BrowserRecordingNativeViewCaptureTransport {
  const randomId = options.randomId ?? randomUUID;
  const ensureDirectory = options.ensureDirectory ?? defaultEnsureDirectory;
  const deleteFile = options.deleteFile ?? defaultDeleteFile;
  const outputDirectory = options.outputDirectory
    ?? join(options.workingDirectory, '.happier', 'tmp', 'browser-recordings');

  return {
    async captureFrame({ recording, maxBytes }) {
      const captureRequestId = randomId();
      const outputPath = `${recording.recordingId}.${captureRequestId}.native-view.png`;

      await ensureDirectory(outputDirectory);

      const request: DesktopBrowserRecordingFrameCaptureRequest = {
        browserSessionId: recording.browserSessionId,
        viewId: recording.viewId,
        navigationGeneration: recording.navigationGenerationStart,
        captureRequestId,
        outputPath,
        maxBytes,
      };

      const result = await options.invokeRecordingFrameCapture(request);

      if (!result.ok) {
        return { ok: false, reasonCode: result.errorCode };
      }

      return {
        ok: true,
        path: result.frame.path,
        mimeType: result.frame.mimeType,
        byteSize: result.frame.sizeBytes,
        width: result.frame.width,
        height: result.frame.height,
        cleanup: () => deleteFile(result.frame.path).catch(() => undefined),
      };
    },
  };
}
