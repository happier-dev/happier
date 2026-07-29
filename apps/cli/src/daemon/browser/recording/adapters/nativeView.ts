import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';

import type {
  BrowserRecordingCaptureAdapter,
  BrowserRecordingCapturedArtifact,
  BrowserRecordingDaemonUnavailableReason,
} from '../service';

/**
 * Reference-only native still-capture result. The native producer writes the capture to a
 * local file and returns only a `local-file`/`local-uri` reference plus metadata — never raw
 * inline bytes (BRW-15 reference-only invariant).
 */
export type BrowserRecordingNativeViewCaptureResult =
  | Readonly<{
    ok: true;
    source: BrowserRecordingCapturedArtifact['source'];
    byteSize: number;
    width?: number;
    height?: number;
    cleanup?: () => Promise<void>;
  }>
  | Readonly<{ ok: false; reasonCode: string }>;

export type BrowserRecordingNativeViewCaptureCommand = (
  input: Readonly<{ recording: BrowserRecordingSessionV1 }>,
) => Promise<BrowserRecordingNativeViewCaptureResult>;

export type BrowserRecordingNativeViewCaptureAdapterOptions = Readonly<{
  /**
   * Read-only per-platform capture-support flag, sourced from the native producer's
   * `DesktopBrowserSupport.capture` (today: macOS only; X11/Windows flip is owned by
   * FP-DESKTOP-HARDEN-1). The adapter advertises a `nativeViewCapture` artifact ONLY when this
   * returns true — no daemon-side over-claim.
   */
  isPlatformCaptureSupported: () => boolean;
  /**
   * The native still-capture command bridge. The daemon->native IPC path IS wired now: the daemon
   * entrypoint binds this command to the cross-process reverse channel (W2C-BA-1) — the spawned cli
   * daemon asks the connected desktop UI, over the persistent machine socket
   * (`RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME`), to capture each reference-only frame from the
   * Wry WebView it owns. The command is therefore normally bound; when no desktop UI is reachable the
   * reverse invoke fails closed and the adapter reports `browser_recording_capture_adapter_missing`
   * rather than fabricating a frame. It is left optional only so tests/QA can omit it.
   */
  captureCommand?: BrowserRecordingNativeViewCaptureCommand;
  nowMs?: () => number;
}>;

type ActiveNativeCapture = Readonly<{
  recording: BrowserRecordingSessionV1;
  result: Extract<BrowserRecordingNativeViewCaptureResult, { ok: true }>;
}>;

function unavailable(
  code: BrowserRecordingDaemonUnavailableReason['code'],
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

/**
 * Daemon-side `nativeViewCapture` recording adapter. Plugs into the SAME
 * `BrowserRecordingCaptureAdapter` seam as the PMS stream adapter — never a second capture
 * path, and never maps a PMS stream producer onto a desktop view. Capability-true: it is only
 * advertised where the native producer reports `capture:true`, and only produces an artifact
 * when a real native capture command is bound; otherwise it stays fail-closed.
 */
export function createBrowserRecordingNativeViewCaptureAdapter(
  options: BrowserRecordingNativeViewCaptureAdapterOptions,
): BrowserRecordingCaptureAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const activeByRecordingId = new Map<string, ActiveNativeCapture>();

  return {
    captureKind: 'nativeViewCapture',

    async start(input) {
      if (!options.isPlatformCaptureSupported()) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'Native view capture is not supported on this platform.',
          ),
        };
      }
      if (!options.captureCommand) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_adapter_missing',
            'Native view capture producer is not available for this daemon runtime.',
          ),
        };
      }

      let result: BrowserRecordingNativeViewCaptureResult;
      try {
        result = await options.captureCommand({ recording: input.recording });
      } catch {
        return {
          status: 'unavailable',
          reason: unavailable('browser_recording_capture_failed', 'Native view capture failed to start.'),
        };
      }
      if (!result.ok) {
        return {
          status: 'unavailable',
          reason: unavailable('browser_recording_capture_unavailable', result.reasonCode),
        };
      }

      activeByRecordingId.set(input.recording.recordingId, { recording: input.recording, result });
      return { status: 'started' };
    },

    async stop(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) {
        throw new Error('Native view recording is not active.');
      }
      activeByRecordingId.delete(input.recordingId);
      return {
        durationMs: Math.max(0, nowMs() - active.recording.startedAtMs),
        byteSize: active.result.byteSize,
        frameCount: 1,
        fps: 1,
        mimeType: active.recording.mimeType,
        source: active.result.source,
        ...(active.result.cleanup ? { cleanup: active.result.cleanup } : {}),
      } satisfies BrowserRecordingCapturedArtifact;
    },

    async discard(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) return;
      activeByRecordingId.delete(input.recordingId);
      await active.result.cleanup?.().catch(() => undefined);
    },
  };
}
