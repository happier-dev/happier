import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';

import type {
  BrowserRecordingCaptureAdapter,
  BrowserRecordingCapturedArtifact,
  BrowserRecordingDaemonUnavailableReason,
} from '../service';
import type {
  BrowserRecordingStreamFrameEncoder,
  BrowserRecordingStreamFrameEncoderFactory,
} from './stream';

/**
 * A single CDP `Page.screencastFrame` payload. Chromium emits these as base64 JPEG stills with a
 * per-frame `sessionId` that MUST be acked (`Page.screencastFrameAck`) so the page keeps emitting.
 * Keeping each JPEG frame addressable is our edge over T3's webm re-encode (per-frame multimodal
 * evidence) — they pass straight into the canonical mjpeg→webm encoder unchanged.
 */
export type BrowserRecordingCdpScreencastFrame = Readonly<{
  sessionId: number;
  dataBase64: string;
  timestampMs: number;
}>;

export type BrowserRecordingCdpScreencastSession = Readonly<{
  /** Ack the CDP screencast frame so Chromium dispatches the next one. */
  ackFrame(sessionId: number): void;
  /** Stop `Page.screencast` and release the CDP subscription. */
  stop(): Promise<void>;
}>;

/**
 * The managed-Chromium boundary the screencast producer talks to. This is the ONLY seam that
 * reaches the live sidecar CDP transport (`Page.startScreencast({format:'jpeg'})` + the
 * `screencastFrame` event subscription); everything above it (encoding, bounding, media
 * persistence) is daemon logic and is unit-tested against a fake transport. Returns `null` when
 * the view is not bound / the page cannot start a screencast (fail-closed/honest).
 */
export type BrowserRecordingCdpScreencastTransport = Readonly<{
  start(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    onFrame: (frame: BrowserRecordingCdpScreencastFrame) => void;
    onError?: (error: unknown) => void;
  }>): Promise<BrowserRecordingCdpScreencastSession | null>;
}>;

export type BrowserRecordingCdpScreencastCaptureAdapterOptions = Readonly<{
  transport: BrowserRecordingCdpScreencastTransport;
  encoderFactory: BrowserRecordingStreamFrameEncoderFactory;
  nowMs?: () => number;
}>;

type ActiveScreencastRecording = {
  readonly recording: BrowserRecordingSessionV1;
  readonly encoder: BrowserRecordingStreamFrameEncoder;
  readonly session: BrowserRecordingCdpScreencastSession;
  frameCount: number;
  totalRawBytes: number;
  fatalError: unknown;
};

function unavailable(
  code: BrowserRecordingDaemonUnavailableReason['code'],
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

function calculateFps(frameCount: number, durationMs: number): number {
  if (durationMs <= 0) return frameCount > 0 ? frameCount : 0;
  return frameCount / (durationMs / 1000);
}

/**
 * Secondary safety bound on top of the aggregate byte budget: cap the number of accepted frames so
 * a misbehaving page that emits far faster than the negotiated fps can never accumulate unbounded
 * work. Derived from the recording's duration cap + fps with a small burst headroom.
 */
function resolveMaxFrames(recording: BrowserRecordingSessionV1): number {
  const seconds = Math.max(1, Math.ceil(recording.maxDurationMs / 1000));
  const fps = Math.max(1, Math.floor(recording.fps));
  return seconds * fps + fps;
}

/**
 * Daemon-side `cdpScreencast` recording adapter (BA-4). Plugs into the SAME
 * `BrowserRecordingCaptureAdapter` seam as the PMS stream + native-view adapters — never a second
 * capture path. JPEG screencast frames are streamed straight into the canonical mjpeg→webm encoder
 * (no in-memory frame accumulation); the aggregate raw byte budget + frame cap + the encoder's own
 * backpressure guard keep it bounded. The transport seam stays injectable so the producer is fully
 * unit-tested without launching Chromium.
 */
export function createBrowserRecordingCdpScreencastCaptureAdapter(
  options: BrowserRecordingCdpScreencastCaptureAdapterOptions,
): BrowserRecordingCaptureAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const activeByRecordingId = new Map<string, ActiveScreencastRecording>();

  return {
    captureKind: 'cdpScreencast',

    async start(input) {
      if (activeByRecordingId.has(input.recording.recordingId)) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_already_active',
            'CDP screencast recording is already active.',
          ),
        };
      }
      if (input.recording.mimeType !== 'video/webm') {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_mime_unavailable',
            'CDP screencast recording only supports video/webm output.',
          ),
        };
      }

      let encoder: BrowserRecordingStreamFrameEncoder;
      try {
        encoder = await options.encoderFactory({
          recording: input.recording,
          outputMimeType: 'video/webm',
        });
      } catch {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_failed',
            'Browser recording encoder could not be created.',
          ),
        };
      }

      const maxRawBytes = Math.max(1, input.recording.maxBytes);
      const maxFrames = resolveMaxFrames(input.recording);
      const recordingId = input.recording.recordingId;

      // CDP `screencastFrame` events only arrive after `Page.startScreencast` resolves (on later
      // event-loop ticks), so the active record is always present by the time a frame fires. A
      // frame seen before the record exists is dropped (it could not be acked without a session).
      const onFrame = (frame: BrowserRecordingCdpScreencastFrame): void => {
        const active = activeByRecordingId.get(recordingId);
        if (!active) return;
        try {
          if (active.fatalError) return;
          const payload = Buffer.from(frame.dataBase64, 'base64');
          const withinByteBudget = active.totalRawBytes + payload.byteLength <= maxRawBytes;
          const withinFrameBudget = active.frameCount < maxFrames;
          if (!withinByteBudget || !withinFrameBudget) {
            // Bound reached: drain (ack) but never accumulate past the cap.
            return;
          }
          try {
            active.encoder.appendFrame({
              sequence: active.frameCount,
              timestampMs: frame.timestampMs,
              payloadKind: 'image_keyframe',
              payload,
            });
            active.frameCount += 1;
            active.totalRawBytes += payload.byteLength;
          } catch (error) {
            active.fatalError = error;
          }
        } finally {
          // ALWAYS ack so Chromium keeps emitting (or drains promptly when we have stopped).
          active.session.ackFrame(frame.sessionId);
        }
      };

      const session = await options.transport
        .start({
          recording: input.recording,
          onFrame,
          onError: (error) => {
            const active = activeByRecordingId.get(recordingId);
            if (active) active.fatalError = error;
          },
        })
        .catch(async () => {
          await encoder.discard({ recording: input.recording, reason: 'capture_failed' }).catch(() => undefined);
          return null;
        });
      if (!session) {
        await encoder.discard({ recording: input.recording, reason: 'capture_unavailable' }).catch(() => undefined);
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'CDP screencast capture could not be started for this view.',
          ),
        };
      }

      activeByRecordingId.set(recordingId, {
        recording: input.recording,
        encoder,
        session,
        frameCount: 0,
        totalRawBytes: 0,
        fatalError: null,
      });
      return { status: 'started' };
    },

    async stop(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) {
        throw new Error('CDP screencast recording is not active.');
      }
      try {
        await active.session.stop();
        if (active.fatalError) {
          throw new Error('CDP screencast frame encoding failed.');
        }
        const durationMs = Math.max(0, nowMs() - active.recording.startedAtMs);
        const output = await active.encoder.finish({
          recording: active.recording,
          frameCount: active.frameCount,
          durationMs,
        });
        activeByRecordingId.delete(input.recordingId);
        return {
          durationMs,
          byteSize: output.byteSize,
          frameCount: active.frameCount,
          fps: Math.min(active.recording.fps, calculateFps(active.frameCount, durationMs)),
          mimeType: 'video/webm',
          source: output.source,
          ...(output.cleanup ? { cleanup: output.cleanup } : {}),
        } satisfies BrowserRecordingCapturedArtifact;
      } catch (error) {
        await active.encoder.discard({ recording: active.recording, reason: 'capture_failed' }).catch(() => undefined);
        activeByRecordingId.delete(input.recordingId);
        throw error;
      }
    },

    async discard(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) return;
      activeByRecordingId.delete(input.recordingId);
      await active.session.stop().catch(() => undefined);
      await active.encoder.discard({ recording: active.recording, reason: input.reason }).catch(() => undefined);
    },
  };
}
