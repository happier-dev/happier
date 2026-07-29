import {
  MACHINE_LIVE_STREAM_BASELINE_CODEC_V1,
  type BrowserRecordingMachineLiveStreamCaptureSourceV1,
  type BrowserRecordingOutcomeReasonV1,
  type BrowserRecordingSessionV1,
  type MachineLiveStreamFrameV1,
  type MachineLiveStreamReceiptV1,
  type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import type {
  BrowserRecordingCaptureAdapter,
  BrowserRecordingCapturedArtifact,
  BrowserRecordingDaemonUnavailableReason,
} from '../service';
import type { MachineLiveStreamCaptureSession } from '../../../peer/mediation/stream/captureAdapter';
import type {
  MachineLiveStreamCaptureRegistry,
  MachineLiveStreamRegisteredCaptureSource,
} from '../../../peer/mediation/stream/captureRegistry';
import { startMachineLiveStreamFramePump } from '../../../peer/mediation/stream/framePump';

export type BrowserRecordingStreamFrameEncoderFrame = Readonly<{
  sequence: number;
  timestampMs: number;
  payloadKind: Extract<MachineLiveStreamFrameV1['payloadKind'], 'image_delta' | 'image_keyframe'>;
  payload: Buffer;
}>;

export type BrowserRecordingStreamFrameEncoderOutput = Readonly<{
  source: BrowserRecordingCapturedArtifact['source'];
  byteSize: number;
  cleanup?: () => Promise<void>;
}>;

export type BrowserRecordingStreamFrameEncoder = Readonly<{
  appendFrame(input: BrowserRecordingStreamFrameEncoderFrame): void;
  finish(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    frameCount: number;
    durationMs: number;
  }>): Promise<BrowserRecordingStreamFrameEncoderOutput>;
  discard(input: Readonly<{
    recording: BrowserRecordingSessionV1;
    reason: BrowserRecordingOutcomeReasonV1;
  }>): Promise<void>;
}>;

export type BrowserRecordingStreamFrameEncoderFactory = (
  input: Readonly<{
    recording: BrowserRecordingSessionV1;
    // The PMS capture-source descriptors are only meaningful to the live-stream producer; the
    // ffmpeg encoder ignores them. They are optional so the same canonical encoder factory can be
    // reused by frame producers that have no machine-live-stream source (e.g. the CDP screencast
    // producer feeds JPEG frames straight from Chromium).
    captureSource?: BrowserRecordingMachineLiveStreamCaptureSourceV1;
    registeredSource?: MachineLiveStreamRegisteredCaptureSource;
    outputMimeType: 'video/webm';
  }>,
) => Promise<BrowserRecordingStreamFrameEncoder>;

export type BrowserRecordingStreamFrameCaptureAdapterOptions = Readonly<{
  captureRegistry: MachineLiveStreamCaptureRegistry;
  encoderFactory: BrowserRecordingStreamFrameEncoderFactory;
  sourceMachineId?: string;
  targetMachineId?: string;
  nowMs?: () => number;
  emitReceipt?: (receipt: MachineLiveStreamReceiptV1) => void;
}>;

type ActiveStreamRecording = Readonly<{
  recording: BrowserRecordingSessionV1;
  encoder: BrowserRecordingStreamFrameEncoder;
  captureSession: MachineLiveStreamCaptureSession;
  frameCount: () => number;
  fatalError: () => unknown;
}>;

function unavailable(
  code: BrowserRecordingDaemonUnavailableReason['code'],
  message: string,
): BrowserRecordingDaemonUnavailableReason {
  return { code, message };
}

function resolveCaptureSource(
  value: unknown,
): BrowserRecordingMachineLiveStreamCaptureSourceV1 | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BrowserRecordingMachineLiveStreamCaptureSourceV1>;
  return candidate.kind === 'machineLiveStream' ? candidate as BrowserRecordingMachineLiveStreamCaptureSourceV1 : null;
}

function buildStartRequest(input: Readonly<{
  recording: BrowserRecordingSessionV1;
  captureSource: BrowserRecordingMachineLiveStreamCaptureSourceV1;
  sourceMachineId: string;
  targetMachineId: string;
}>): MachineLiveStreamStartRequestV1 {
  const maxFramesPerSecond = Math.max(1, Math.floor(input.recording.fps));
  return {
    v: 1,
    streamId: input.recording.recordingId,
    streamFamily: input.captureSource.streamFamily,
    routeKind: 'loopback_direct',
    sourceMachineId: input.captureSource.sourceMachineId ?? input.sourceMachineId,
    targetMachineId: input.captureSource.targetMachineId ?? input.targetMachineId,
    maxBitrateBps: Math.max(1, input.recording.maxBytes * 8),
    maxFramesPerSecond,
    maxFrameBytes: input.recording.maxBytes,
    maxDurationMs: input.recording.maxDurationMs,
    maxTotalBytes: input.recording.maxBytes,
  };
}

function calculateFps(frameCount: number, durationMs: number): number {
  if (durationMs <= 0) return frameCount > 0 ? frameCount : 0;
  return frameCount / (durationMs / 1000);
}

async function stopCaptureSession(captureSession: MachineLiveStreamCaptureSession): Promise<void> {
  await captureSession.stop();
}

export function createBrowserRecordingStreamFrameCaptureAdapter(
  options: BrowserRecordingStreamFrameCaptureAdapterOptions,
): BrowserRecordingCaptureAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const activeByRecordingId = new Map<string, ActiveStreamRecording>();

  return {
    captureKind: 'streamFrameCapture',

    async start(input) {
      if (activeByRecordingId.has(input.recording.recordingId)) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_already_active',
            'Browser stream recording is already active.',
          ),
        };
      }
      if (input.recording.mimeType !== 'video/webm') {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_mime_unavailable',
            'Machine live-stream recording only supports video/webm output.',
          ),
        };
      }

      const captureSource = resolveCaptureSource(input.captureSource);
      if (!captureSource) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'Machine live-stream capture requires an explicit capture source.',
          ),
        };
      }
      const resolved = options.captureRegistry.resolve({
        sourceId: captureSource.sourceId,
        streamFamily: captureSource.streamFamily,
      });
      if (!resolved.ok) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            resolved.diagnostic.reasonCode,
          ),
        };
      }
      if (resolved.source.streamFamily !== captureSource.streamFamily) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'Machine live-stream capture source does not match the requested stream family.',
          ),
        };
      }
      if (resolved.source.capabilities.health.status !== 'available') {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            resolved.source.capabilities.health.reasonCode ?? 'Machine live-stream source is unavailable.',
          ),
        };
      }
      if (!resolved.source.capabilities.supportedCodecs.includes(MACHINE_LIVE_STREAM_BASELINE_CODEC_V1)) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_unavailable',
            'Machine live-stream recording requires image.mjpeg capture frames.',
          ),
        };
      }

      let encoder: BrowserRecordingStreamFrameEncoder;
      try {
        encoder = await options.encoderFactory({
          recording: input.recording,
          captureSource,
          registeredSource: resolved.source,
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

      let frameCount = 0;
      let fatalError: unknown = null;
      const pump = startMachineLiveStreamFramePump({
        streamId: input.recording.recordingId,
        routeKind: 'loopback_direct',
        caps: buildStartRequest({
          recording: input.recording,
          captureSource,
          sourceMachineId: options.sourceMachineId ?? 'local-machine',
          targetMachineId: options.targetMachineId ?? options.sourceMachineId ?? 'local-machine',
        }),
        startedAtMs: input.recording.startedAtMs,
        nowMs,
        emitFrame: (frame) => {
          if (frame.payloadKind === 'metadata') return;
          const payload = Buffer.from(frame.payloadBase64, 'base64');
          try {
            encoder.appendFrame({
              sequence: frame.sequence,
              timestampMs: frame.timestampMs,
              payloadKind: frame.payloadKind,
              payload,
            });
            frameCount += 1;
          } catch (error) {
            fatalError = error;
          }
        },
        emitReceipt: (receipt) => {
          options.emitReceipt?.(receipt);
        },
      });
      const startRequest = buildStartRequest({
        recording: input.recording,
        captureSource,
        sourceMachineId: options.sourceMachineId ?? 'local-machine',
        targetMachineId: options.targetMachineId ?? options.sourceMachineId ?? 'local-machine',
      });

      const capture = await resolved.source.adapter.start({
        streamId: input.recording.recordingId,
        streamFamily: captureSource.streamFamily,
        sourceMachineId: startRequest.sourceMachineId,
        targetMachineId: startRequest.targetMachineId,
        caps: startRequest,
        startRequest,
        startedAtMs: input.recording.startedAtMs,
        expiresAtMs: input.recording.startedAtMs + input.recording.maxDurationMs,
        nowMs,
        offerFrame: pump.offerFrame,
        applyControl: pump.applyControl,
        emitReceipt: (receipt) => {
          options.emitReceipt?.(receipt);
        },
      }).catch(async () => {
        await encoder.discard({ recording: input.recording, reason: 'capture_failed' }).catch(() => undefined);
        return null;
      });
      if (!capture) {
        return {
          status: 'unavailable',
          reason: unavailable(
            'browser_recording_capture_failed',
            'Browser recording capture failed to start.',
          ),
        };
      }
      if (!capture.ok) {
        await encoder.discard({ recording: input.recording, reason: 'capture_unavailable' });
        return {
          status: 'unavailable',
          reason: unavailable('browser_recording_capture_unavailable', capture.reasonCode),
        };
      }
      if (fatalError) {
        await stopCaptureSession(capture.session).catch(() => undefined);
        await encoder.discard({ recording: input.recording, reason: 'capture_failed' });
        return {
          status: 'unavailable',
          reason: unavailable('browser_recording_capture_failed', 'Browser recording frame encoding failed.'),
        };
      }

      activeByRecordingId.set(input.recording.recordingId, {
        recording: input.recording,
        encoder,
        captureSession: capture.session,
        frameCount: () => frameCount,
        fatalError: () => fatalError,
      });
      return { status: 'started' };
    },

    async stop(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) {
        throw new Error('Browser stream recording is not active.');
      }
      try {
        await stopCaptureSession(active.captureSession);
        if (active.fatalError()) {
          throw new Error('Browser stream recording frame encoding failed.');
        }
        const durationMs = Math.max(0, nowMs() - active.recording.startedAtMs);
        const output = await active.encoder.finish({
          recording: active.recording,
          frameCount: active.frameCount(),
          durationMs,
        });
        activeByRecordingId.delete(input.recordingId);
        return {
          durationMs,
          byteSize: output.byteSize,
          frameCount: active.frameCount(),
          fps: calculateFps(active.frameCount(), durationMs),
          mimeType: 'video/webm',
          source: output.source,
          cleanup: output.cleanup,
        };
      } catch (error) {
        await active.encoder.discard({ recording: active.recording, reason: 'capture_failed' });
        activeByRecordingId.delete(input.recordingId);
        throw error;
      }
    },

    async discard(input) {
      const active = activeByRecordingId.get(input.recordingId);
      if (!active) return;
      activeByRecordingId.delete(input.recordingId);
      await stopCaptureSession(active.captureSession).catch(() => undefined);
      await active.encoder.discard({ recording: active.recording, reason: input.reason }).catch(() => undefined);
    },
  };
}
