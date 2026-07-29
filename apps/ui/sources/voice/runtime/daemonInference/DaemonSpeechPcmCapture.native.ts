import {
  getSharedVoicePcmCapture,
  type AudioStreamFrameEvent,
  type VoicePcmCapture,
  type VoicePcmCaptureLease,
} from '@happier-dev/audio-stream-native';
import { decodeBase64, VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

export type DaemonSpeechPcmCaptureOptions = Readonly<{
  micSession: MicSession;
  onAudioStarted: () => void;
  onChunk: (pcm16Bytes: Uint8Array) => Promise<void>;
  onError?: (error: ReturnType<typeof createVoiceMachineError>) => void;
  signal?: AbortSignal | null;
  maxQueuedChunks?: number;
}>;

export type DaemonSpeechPcmCapture = Readonly<{
  start: () => Promise<void>;
  stop: () => Promise<void>;
  waitForDrain: () => Promise<void>;
  isActive: () => boolean;
}>;

const FRAME_MS = 20;
const DEFAULT_MAX_QUEUED_CHUNKS = 8;
const TARGET_SAMPLE_RATE = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz;
const TARGET_CHANNELS = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function decodePcm16Base64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) return null;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const byteLength = normalized.length / 4 * 3 - padding;
  if (byteLength <= 0 || byteLength % 2 !== 0) return null;
  const decoded = decodeBase64(normalized, 'base64');
  return decoded.byteLength === byteLength && decoded.byteLength % 2 === 0 ? decoded : null;
}

function isCanonicalFrame(event: AudioStreamFrameEvent): boolean {
  return event.sampleRate === TARGET_SAMPLE_RATE && event.channels === TARGET_CHANNELS;
}

export function createDaemonSpeechPcmCapture(options: DaemonSpeechPcmCaptureOptions): DaemonSpeechPcmCapture {
  const maxQueuedChunks = normalizePositiveInteger(options.maxQueuedChunks, DEFAULT_MAX_QUEUED_CHUNKS);
  let active = false;
  let audioStarted = false;
  let capture: VoicePcmCapture | null = null;
  let lease: VoicePcmCaptureLease | null = null;
  let stopPromise: Promise<void> | null = null;
  let unlinkAbort = (): void => {};

  const reportError = (reason: string): void => {
    options.onError?.(createVoiceMachineError({ kind: 'provider_error', reason }));
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      active = false;
      unlinkAbort();
      unlinkAbort = (): void => {};
      const currentLease = lease;
      lease = null;
      await currentLease?.release().catch(() => {});
      await currentLease?.waitForDrain().catch(() => {});
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const failAndStop = (reason: string): void => {
    if (!active) return;
    reportError(reason);
    void stop();
  };

  const handleFrame = async (event: AudioStreamFrameEvent): Promise<void> => {
    if (!active || options.micSession.isMuted() || !isCanonicalFrame(event)) return;
    const pcm16Bytes = decodePcm16Base64(event.pcm16leBase64);
    if (!pcm16Bytes) return;
    if (!audioStarted) {
      audioStarted = true;
      options.onAudioStarted();
    }
    await options.onChunk(pcm16Bytes);
  };

  const start = async (): Promise<void> => {
    if (active || lease || options.signal?.aborted) return;
    capture = getSharedVoicePcmCapture();
    if (!capture) {
      reportError('daemon_streaming_stt_pcm_capture_unavailable');
      return;
    }
    if (options.signal) {
      const abort = (): void => { void stop(); };
      options.signal.addEventListener('abort', abort, { once: true });
      unlinkAbort = () => options.signal?.removeEventListener('abort', abort);
    }

    try {
      await options.micSession.ensureActive();
      if (options.signal?.aborted) {
        await stop();
        return;
      }
      active = true;
      lease = await capture.acquire({
        ownerId: 'daemon-streaming-stt',
        format: { sampleRate: TARGET_SAMPLE_RATE, channels: TARGET_CHANNELS, frameMs: FRAME_MS },
        audioSession: {
          mode: 'conversation',
          input: true,
          output: true,
          aec: 'preferred',
        },
        maxQueuedFrames: maxQueuedChunks,
        shouldDeliver: () => active && !options.micSession.isMuted(),
        onFrame: handleFrame,
        onDroppedFrames: () => failAndStop('daemon_streaming_stt_pcm_backpressure'),
        onError: () => failAndStop('daemon_streaming_stt_pcm_chunk_failed'),
      });
      if (options.signal?.aborted) await stop();
    } catch {
      active = false;
      reportError('daemon_streaming_stt_pcm_capture_start_failed');
      await stop();
    }
  };

  return {
    start,
    stop,
    waitForDrain: async () => {
      await lease?.waitForDrain();
    },
    isActive: () => active,
  };
}
