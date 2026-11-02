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
  /** Release this recording's subscription; other page consumers remain active. */
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
  readonly frames: {
    frameCount: number;
    fatalError: unknown;
    closed: boolean;
  };
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
 * Daemon-side `cdpScreencast` recording adapter (BA-4). Plugs into the SAME
 * `BrowserRecordingCaptureAdapter` seam as the PMS stream + native-view adapters — never a second
 * capture path. JPEG screencast frames are streamed straight into the canonical mjpeg→webm encoder
 * (no in-memory frame accumulation); the encoder's backpressure bounds pending work.
 * The transport seam stays injectable so the producer is fully
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

      const recordingId = input.recording.recordingId;
      const frames: ActiveScreencastRecording['frames'] = {
        frameCount: 0, fatalError: null, closed: false,
      };

      // The shared page producer owns ACKs, including frames arriving during capture startup.
      const onFrame = (frame: BrowserRecordingCdpScreencastFrame): void => {
        if (frames.closed) return;
        try {
          if (frames.fatalError) return;
          const payload = Buffer.from(frame.dataBase64, 'base64');
          try {
            const accepted = encoder.appendFrame({
              sequence: frames.frameCount,
              timestampMs: frame.timestampMs,
              payloadKind: 'image_keyframe',
              payload,
            });
            if (accepted !== false) {
              frames.frameCount += 1;
            }
          } catch (error) {
            frames.fatalError = error;
          }
        } catch (error) {
          frames.fatalError = error;
        }
      };

      const session = await options.transport
        .start({
          recording: input.recording,
          onFrame,
          onError: (error) => {
            frames.fatalError = error;
          },
        })
        .catch(async () => {
          await encoder.discard({ recording: input.recording, reason: 'capture_failed' }).catch(() => undefined);
          return null;
        });
      if (!session) {
        frames.closed = true;
        await encoder.discard({ recording: input.recording, reason: 'capture_unavailable' }).catch(() => undefined);
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'CDP screencast capture could not be started for this view.',
          ),
        };
      }
      if (frames.fatalError) {
        frames.closed = true;
        try { await session.stop(); }
        finally { await encoder.discard({ recording: input.recording, reason: 'capture_failed' }); }
        return { status: 'unavailable', reason: unavailable('browser_recording_capture_failed', 'CDP screencast capture failed during startup.') };
      }

      activeByRecordingId.set(recordingId, {
        recording: input.recording,
        encoder,
        session,
        frames,
      });
      return { status: 'started' };
    },

    async stop(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) {
        throw new Error('CDP screencast recording is not active.');
      }
      try {
        active.frames.closed = true;
        await active.session.stop();
        if (active.frames.fatalError) {
          throw new Error('CDP screencast frame encoding failed.');
        }
        const durationMs = Math.max(0, nowMs() - active.recording.startedAtMs);
        const output = await active.encoder.finish({
          recording: active.recording,
          frameCount: active.frames.frameCount,
          durationMs,
        });
        activeByRecordingId.delete(input.recordingId);
        return {
          durationMs,
          byteSize: output.byteSize,
          frameCount: active.frames.frameCount,
          fps: Math.min(active.recording.fps, calculateFps(active.frames.frameCount, durationMs)),
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
      active.frames.closed = true;
      activeByRecordingId.delete(input.recordingId);
      try {
        await active.session.stop();
      } finally {
        await active.encoder.discard({ recording: active.recording, reason: input.reason });
      }
    },
  };
}
