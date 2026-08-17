import type {
  AudioStreamCaptureTerminalEvent,
  AudioStreamFrameEvent,
  HappierAudioStreamNativeModule,
} from './HappierAudioStreamNative.types';
import type {
  VoiceAudioSessionCoordinator,
  VoiceAudioSessionLease,
  VoiceAudioSessionRequest,
} from './voiceAudioSessionCoordinator';

export type VoicePcmCaptureFormat = Readonly<{
  sampleRate: number;
  channels: 1 | 2;
  frameMs: number;
}>;

export type VoicePcmCaptureSubscriberRequest = Readonly<{
  ownerId: string;
  format: VoicePcmCaptureFormat;
  audioSession?: Omit<VoiceAudioSessionRequest, 'ownerId' | 'capture'>;
  onFrame: (frame: AudioStreamFrameEvent) => void | Promise<void>;
  shouldDeliver?: () => boolean;
  maxQueuedFrames?: number;
  onDroppedFrames?: (totalDropped: number) => void;
  onError?: (error: unknown) => void;
}>;

export type VoicePcmCaptureLease = Readonly<{
  id: string;
  streamId: string;
  generation: number;
  waitForDrain: () => Promise<void>;
  release: () => Promise<void>;
}>;

export type VoicePcmCaptureSnapshot = Readonly<{
  generation: number;
  streamId: string | null;
  subscriberCount: number;
  format: VoicePcmCaptureFormat | null;
}>;

export type VoicePcmCapture = Readonly<{
  acquire: (request: VoicePcmCaptureSubscriberRequest) => Promise<VoicePcmCaptureLease>;
  waitForDrain: () => Promise<void>;
  getSnapshot: () => VoicePcmCaptureSnapshot;
  dispose: () => Promise<void>;
}>;

export class VoicePcmCaptureError extends Error {
  readonly code: 'invalid_capture_request' | 'capture_format_conflict';

  constructor(code: VoicePcmCaptureError['code'], message: string) {
    super(message);
    this.name = 'VoicePcmCaptureError';
    this.code = code;
  }
}

type Subscriber = {
  readonly id: string;
  readonly request: VoicePcmCaptureSubscriberRequest;
  queuedFrames: number;
  droppedFrames: number;
  tail: Promise<void>;
  active: boolean;
};

function normalizeQueueBound(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isFinite(value)) return 8;
  return Math.max(1, Math.trunc(value));
}

function validateFormat(format: VoicePcmCaptureFormat): void {
  if (
    !Number.isInteger(format.sampleRate)
    || format.sampleRate <= 0
    || (format.channels !== 1 && format.channels !== 2)
    || !Number.isInteger(format.frameMs)
    || format.frameMs <= 0
  ) {
    throw new VoicePcmCaptureError('invalid_capture_request', 'PCM capture format values must be positive integers.');
  }
}

function sameFormat(left: VoicePcmCaptureFormat, right: VoicePcmCaptureFormat): boolean {
  return left.sampleRate === right.sampleRate
    && left.channels === right.channels
    && left.frameMs === right.frameMs;
}

function sameAudioSessionRequest(
  left: Omit<VoiceAudioSessionRequest, 'ownerId' | 'capture'>,
  right: Omit<VoiceAudioSessionRequest, 'ownerId' | 'capture'>,
): boolean {
  return left.mode === right.mode
    && left.input === right.input
    && left.output === right.output
    && left.aec === right.aec;
}

function isCaptureTerminalEvent(event: unknown): event is AudioStreamCaptureTerminalEvent {
  if (typeof event !== 'object' || event === null) return false;
  const candidate = event as Record<string, unknown>;
  return typeof candidate.streamId === 'string'
    && candidate.streamId.trim().length > 0
    && typeof candidate.generation === 'number'
    && Number.isSafeInteger(candidate.generation)
    && candidate.generation > 0
    && (candidate.reason === 'read_error' || candidate.reason === 'dead_object');
}

function createNativeCaptureTerminalError(reason: AudioStreamCaptureTerminalEvent['reason']): Error {
  const error = new Error(`native_pcm_capture_${reason}`);
  error.name = 'VoicePcmCaptureTerminalError';
  return error;
}

export function createVoicePcmCapture(options: Readonly<{
  nativeModule: HappierAudioStreamNativeModule;
  audioSessionCoordinator: VoiceAudioSessionCoordinator;
  createLeaseId?: () => string;
}>): VoicePcmCapture {
  const subscribers = new Map<string, Subscriber>();
  let generation = 0;
  let streamId: string | null = null;
  let pendingStopStreamId: string | null = null;
  let format: VoicePcmCaptureFormat | null = null;
  let audioSessionRequest: Omit<VoiceAudioSessionRequest, 'ownerId' | 'capture'> | null = null;
  let audioSessionLease: VoiceAudioSessionLease | null = null;
  let frameSubscription: Readonly<{ remove: () => void }> | null = null;
  let terminalSubscription: Readonly<{ remove: () => void }> | null = null;
  let pendingStartupFrames: AudioStreamFrameEvent[] = [];
  let pendingStartupTerminal: AudioStreamCaptureTerminalEvent | null = null;
  let terminatingStreamId: string | null = null;
  let leaseSequence = 0;
  let mutationTail: Promise<void> = Promise.resolve();
  let disposalRequested = false;
  let disposed = false;

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    mutationTail = mutationTail
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveResult(await operation());
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  };

  const reportSubscriberError = (subscriber: Subscriber, error: unknown): void => {
    try {
      subscriber.request.onError?.(error);
    } catch {
      // Error observers are isolated so a broken consumer cannot stop fan-out.
    }
  };

  const enqueue = (subscriber: Subscriber, frame: AudioStreamFrameEvent): void => {
    if (!subscriber.active) return;
    try {
      if (subscriber.request.shouldDeliver?.() === false) return;
    } catch (error) {
      reportSubscriberError(subscriber, error);
      return;
    }
    const maxQueuedFrames = normalizeQueueBound(subscriber.request.maxQueuedFrames);
    if (subscriber.queuedFrames >= maxQueuedFrames) {
      subscriber.droppedFrames += 1;
      try {
        subscriber.request.onDroppedFrames?.(subscriber.droppedFrames);
      } catch (error) {
        reportSubscriberError(subscriber, error);
      }
      return;
    }
    subscriber.queuedFrames += 1;
    subscriber.tail = subscriber.tail
      .catch(() => undefined)
      .then(async () => {
        if (subscriber.active) await subscriber.request.onFrame(frame);
      })
      .catch((error: unknown) => {
        reportSubscriberError(subscriber, error);
      })
      .finally(() => {
        subscriber.queuedFrames = Math.max(0, subscriber.queuedFrames - 1);
      });
  };

  const handleFrame = (event: AudioStreamFrameEvent, activeGeneration: number): void => {
    if (
      disposed
      || activeGeneration !== generation
      || terminatingStreamId !== null
      || pendingStartupTerminal?.generation === activeGeneration
      || !format
      || event.sampleRate !== format.sampleRate
      || event.channels !== format.channels
    ) return;
    if (!streamId) {
      // Android can begin delivering immediately after AudioRecord starts,
      // before the native start promise resolves with its stream ID. Preserve
      // a tiny bounded onset window and validate it against the returned ID.
      if (pendingStartupFrames.length < 2) pendingStartupFrames.push(event);
      return;
    }
    if (event.streamId !== streamId) return;
    for (const subscriber of subscribers.values()) enqueue(subscriber, event);
  };

  const stopNativeCapture = async (): Promise<void> => {
    generation += 1;
    const stoppedStreamId = streamId ?? pendingStopStreamId;
    streamId = null;
    pendingStopStreamId = null;
    format = null;
    audioSessionRequest = null;
    pendingStartupFrames = [];
    pendingStartupTerminal = null;
    terminatingStreamId = null;
    const subscription = frameSubscription;
    const terminal = terminalSubscription;
    frameSubscription = null;
    terminalSubscription = null;
    try {
      try {
        subscription?.remove();
      } finally {
        terminal?.remove();
      }
    } finally {
      let stopFailure: unknown = null;
      if (stoppedStreamId) {
        try {
          await options.nativeModule.stop({ streamId: stoppedStreamId });
        } catch (error) {
          stopFailure = error;
          pendingStopStreamId = stoppedStreamId;
        }
      }
      const lease = audioSessionLease;
      try {
        await lease?.release();
        if (audioSessionLease === lease) audioSessionLease = null;
      } catch (releaseFailure) {
        if (stopFailure) throw new AggregateError(
          [stopFailure, releaseFailure],
          'Native PCM stop and audio-session release both failed.',
        );
        throw releaseFailure;
      }
      if (stopFailure) throw stopFailure;
    }
  };

  const handleCaptureTerminal = (
    event: AudioStreamCaptureTerminalEvent,
    activeGeneration: number,
  ): void => {
    if (
      !isCaptureTerminalEvent(event)
      || disposed
      || event.generation !== activeGeneration
      || activeGeneration !== generation
    ) return;

    if (!streamId) {
      if (pendingStartupTerminal) return;
      pendingStartupTerminal = event;
    } else {
      if (event.streamId !== streamId) return;
      terminatingStreamId = streamId;
    }

    void serialize(async () => {
      if (
        disposed
        || event.generation !== activeGeneration
        || activeGeneration !== generation
        || event.streamId !== streamId
      ) return;
      terminatingStreamId = event.streamId;
      const terminalError = createNativeCaptureTerminalError(event.reason);
      const activeSubscribers = [...subscribers.values()];
      subscribers.clear();
      for (const subscriber of activeSubscribers) {
        subscriber.active = false;
        reportSubscriberError(subscriber, terminalError);
      }
      await stopNativeCapture();
    }).catch(() => undefined);
  };

  const acquire = async (request: VoicePcmCaptureSubscriberRequest): Promise<VoicePcmCaptureLease> => {
    validateFormat(request.format);
    if (request.ownerId.trim().length === 0) {
      throw new VoicePcmCaptureError('invalid_capture_request', 'PCM capture subscribers require an owner ID.');
    }
    return serialize(async () => {
      if (disposalRequested) throw new Error('voice_pcm_capture_disposed');
      if (pendingStopStreamId || (audioSessionLease && !streamId && !frameSubscription)) {
        await stopNativeCapture();
      }
      if (format && !sameFormat(format, request.format)) {
        throw new VoicePcmCaptureError(
          'capture_format_conflict',
          'A native PCM stream is already active with an incompatible format.',
        );
      }

      const sessionRequest = request.audioSession ?? {
        mode: 'dictation' as const,
        input: true,
        output: false,
        aec: 'off' as const,
      };
      if (!sessionRequest.input) {
        throw new VoicePcmCaptureError(
          'invalid_capture_request',
          'Native PCM capture requires an input-enabled audio session.',
        );
      }
      if (audioSessionRequest && !sameAudioSessionRequest(audioSessionRequest, sessionRequest)) {
        throw new VoicePcmCaptureError(
          'capture_format_conflict',
          'A native PCM stream is already active with an incompatible audio-session request.',
        );
      }
      const id = options.createLeaseId?.() ?? `voice-pcm-${++leaseSequence}`;
      let subscriberAdded = false;
      try {
        const subscriber: Subscriber = {
          id,
          request,
          queuedFrames: 0,
          droppedFrames: 0,
          tail: Promise.resolve(),
          active: true,
        };
        subscribers.set(id, subscriber);
        subscriberAdded = true;
        if (!streamId) {
          const acquiredSessionLease = await options.audioSessionCoordinator.acquire({
            ...sessionRequest,
            ownerId: request.ownerId,
            capture: 'host_managed',
          });
          audioSessionLease = acquiredSessionLease;
          audioSessionRequest = { ...sessionRequest };
          generation += 1;
          const activeGeneration = generation;
          format = { ...request.format };
          terminalSubscription = options.nativeModule.addListener(
            'captureTerminal',
            (event) => handleCaptureTerminal(event, activeGeneration),
          );
          frameSubscription = options.nativeModule.addListener(
            'audioFrame',
            (event) => handleFrame(event, activeGeneration),
          );
          const started = await options.nativeModule.start({
            sampleRate: request.format.sampleRate,
            channels: request.format.channels,
            frameMs: request.format.frameMs,
            generation: activeGeneration,
          });
          const normalizedStreamId = started.streamId.trim();
          if (normalizedStreamId.length === 0) throw new Error('voice_pcm_capture_stream_id_missing');
          streamId = normalizedStreamId;
          const startupFrames = pendingStartupFrames;
          pendingStartupFrames = [];
          const startupTerminal = pendingStartupTerminal;
          pendingStartupTerminal = null;
          if (
            startupTerminal
            && startupTerminal.streamId === normalizedStreamId
            && startupTerminal.generation === activeGeneration
          ) {
            terminatingStreamId = normalizedStreamId;
          } else {
            for (const frame of startupFrames) {
              if (frame.streamId === normalizedStreamId) enqueue(subscriber, frame);
            }
          }
        }
        const acquiredStreamId = streamId;
        if (!acquiredStreamId) throw new Error('voice_pcm_capture_stream_id_missing');
        const acquiredGeneration = generation;
        let releaseAttempt: Promise<void> | null = null;
        return {
          id,
          streamId: acquiredStreamId,
          generation: acquiredGeneration,
          waitForDrain: async () => {
            await subscriber.tail.catch(() => undefined);
          },
          release: async () => {
            if (releaseAttempt) return releaseAttempt;
            const attempt = serialize(async () => {
              const active = subscribers.get(id);
              if (active) {
                subscribers.delete(id);
                active.active = false;
              }
              if (subscribers.size === 0 && (active || pendingStopStreamId || audioSessionLease)) {
                await stopNativeCapture();
              }
            });
            releaseAttempt = attempt;
            try {
              await attempt;
            } catch (error) {
              releaseAttempt = null;
              throw error;
            }
          },
        };
      } catch (error) {
        if (subscriberAdded) subscribers.delete(id);
        if (subscribers.size === 0 && (streamId || frameSubscription || terminalSubscription || audioSessionLease)) {
          await stopNativeCapture().catch(() => undefined);
        }
        if (subscribers.size === 0) {
          const lease = audioSessionLease;
          audioSessionRequest = null;
          try {
            await lease?.release();
            if (audioSessionLease === lease) audioSessionLease = null;
          } catch {
            // Retain the exact lease so a later acquire/dispose can retry the
            // coordinator's failed baseline restoration.
          }
        }
        throw error;
      }
    });
  };

  return {
    acquire,
    waitForDrain: async () => {
      await Promise.all([...subscribers.values()].map((subscriber) => subscriber.tail.catch(() => undefined)));
    },
    getSnapshot: () => ({ generation, streamId, subscriberCount: subscribers.size, format }),
    dispose: async () => {
      await serialize(async () => {
        if (disposed) return;
        disposalRequested = true;
        const active = [...subscribers.values()];
        subscribers.clear();
        active.forEach((subscriber) => { subscriber.active = false; });
        await stopNativeCapture();
        disposed = true;
      });
    },
  };
}
