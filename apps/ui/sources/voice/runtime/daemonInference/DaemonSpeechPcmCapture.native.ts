import {
  getOptionalHappierAudioStreamNativeModule,
  type AudioStreamFrameEvent,
  type HappierAudioStreamNativeModule,
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
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
}

function decodePcm16Base64(value: unknown): Uint8Array | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    return null;
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const byteLength = normalized.length / 4 * 3 - padding;
  if (byteLength <= 0 || byteLength % 2 !== 0) {
    return null;
  }
  const decoded = decodeBase64(normalized, 'base64');
  if (decoded.byteLength !== byteLength || decoded.byteLength % 2 !== 0) {
    return null;
  }
  return decoded;
}

function isCanonicalFrame(event: AudioStreamFrameEvent): boolean {
  return event.sampleRate === TARGET_SAMPLE_RATE && event.channels === TARGET_CHANNELS;
}

export function createDaemonSpeechPcmCapture(
  options: DaemonSpeechPcmCaptureOptions,
): DaemonSpeechPcmCapture {
  const maxQueuedChunks = normalizePositiveInteger(options.maxQueuedChunks, DEFAULT_MAX_QUEUED_CHUNKS);
  let active = false;
  let audioStarted = false;
  let nativeModule: HappierAudioStreamNativeModule | null = null;
  let streamId: string | null = null;
  let subscription: Readonly<{ remove: () => void }> | null = null;
  let queuedChunks = 0;
  let drainTail: Promise<void> = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let unlinkAbort = (): void => {};

  const reportError = (reason: string): void => {
    options.onError?.(createVoiceMachineError({ kind: 'provider_error', reason }));
  };

  const removeListener = (): void => {
    const current = subscription;
    subscription = null;
    if (!current) {
      return;
    }
    try {
      current.remove();
    } catch {
      // Best-effort native listener cleanup.
    }
  };

  const stopNativeStream = async (): Promise<void> => {
    const id = streamId;
    const module = nativeModule;
    streamId = null;
    if (!id || !module) {
      return;
    }
    try {
      await module.stop({ streamId: id });
    } catch {
      // Best-effort native stream cleanup.
    }
  };

  const cleanupNativeResources = async (): Promise<void> => {
    active = false;
    unlinkAbort();
    unlinkAbort = (): void => {};
    removeListener();
    await stopNativeStream();
  };

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      await cleanupNativeResources();
      await drainTail.catch(() => {});
    })().finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  };

  const enqueueChunk = (pcm16Bytes: Uint8Array): void => {
    if (!active) {
      return;
    }
    if (queuedChunks >= maxQueuedChunks) {
      reportError('daemon_streaming_stt_pcm_backpressure');
      void stop();
      return;
    }
    queuedChunks += 1;
    drainTail = drainTail
      .catch(() => undefined)
      .then(async () => {
        await options.onChunk(pcm16Bytes);
      })
      .catch(() => {
        reportError('daemon_streaming_stt_pcm_chunk_failed');
        void stop();
      })
      .finally(() => {
        queuedChunks = Math.max(0, queuedChunks - 1);
      });
  };

  const handleAudioFrame = (event: AudioStreamFrameEvent): void => {
    const id = streamId;
    if (!active || !id || event.streamId !== id) {
      return;
    }
    if (options.micSession.isMuted()) {
      return;
    }
    if (!isCanonicalFrame(event)) {
      return;
    }
    const pcm16Bytes = decodePcm16Base64(event.pcm16leBase64);
    if (!pcm16Bytes) {
      return;
    }
    if (!audioStarted) {
      audioStarted = true;
      options.onAudioStarted();
    }
    enqueueChunk(pcm16Bytes);
  };

  const start = async (): Promise<void> => {
    if (active || streamId || options.signal?.aborted) {
      return;
    }
    const module = getOptionalHappierAudioStreamNativeModule();
    if (!module) {
      reportError('daemon_streaming_stt_pcm_capture_unavailable');
      return;
    }
    nativeModule = module;
    if (options.signal) {
      const abort = () => {
        void stop();
      };
      options.signal.addEventListener('abort', abort, { once: true });
      unlinkAbort = () => {
        options.signal?.removeEventListener('abort', abort);
      };
    }

    try {
      await options.micSession.ensureActive();
      if (options.signal?.aborted) {
        await cleanupNativeResources();
        return;
      }
      const started = await module.start({
        sampleRate: TARGET_SAMPLE_RATE,
        channels: TARGET_CHANNELS,
        frameMs: FRAME_MS,
      });
      const startedStreamId = typeof started.streamId === 'string' ? started.streamId.trim() : '';
      if (startedStreamId.length === 0) {
        throw new Error('daemon_streaming_stt_native_stream_id_missing');
      }
      streamId = startedStreamId;
      if (options.signal?.aborted) {
        await cleanupNativeResources();
        return;
      }
      subscription = module.addListener('audioFrame', handleAudioFrame);
      active = true;
    } catch {
      reportError('daemon_streaming_stt_pcm_capture_start_failed');
      await cleanupNativeResources();
    }
  };

  return {
    start,
    stop,
    waitForDrain: async () => {
      await drainTail;
    },
    isActive: () => active,
  };
}
