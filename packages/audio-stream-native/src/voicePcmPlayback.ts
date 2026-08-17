import type {
  AudioStreamPlaybackDrainedEvent,
  AudioStreamPlaybackLevelEvent,
  AudioStreamPlaybackTerminalEvent,
  HappierAudioStreamNativeModule,
  HappierAudioStreamNativePlaybackModule,
} from './HappierAudioStreamNative.types';
import type { VoicePcmCapture } from './voicePcmCapture';

export type VoicePcmPlaybackIdentity = Readonly<{
  streamId: string;
  generation: number;
}>;

export type VoicePcmPlaybackFormat = Readonly<{
  sampleRate: number;
  channels: 1 | 2;
  maxBufferedMs: number;
}>;

export type VoicePcmPlaybackRequest = Readonly<{
  capture: VoicePcmPlaybackIdentity;
  format: VoicePcmPlaybackFormat;
  onOutputLevel?: (level: number) => void;
  onError?: (error: VoicePcmPlaybackError) => void;
}>;

export type VoicePcmPlaybackLease = Readonly<{
  streamId: string;
  generation: number;
  enqueue: (pcm16leBase64: string) => boolean;
  clear: () => void;
  setGain: (gain: number) => boolean;
  playbackCursorMs: () => number;
  waitForDrain: () => Promise<void>;
  release: () => Promise<void>;
}>;

export type VoicePcmPlayback = Readonly<{
  open: (request: VoicePcmPlaybackRequest) => Promise<VoicePcmPlaybackLease>;
  dispose: () => Promise<void>;
}>;

export class VoicePcmPlaybackError extends Error {
  readonly code:
    | 'invalid_playback_request'
    | 'native_playback_unavailable'
    | 'playback_capture_mismatch'
    | 'playback_stream_conflict'
    | 'native_playback_start_failed'
    | 'native_playback_write_error'
    | 'native_playback_player_error'
    | 'voice_pcm_playback_disposed';

  constructor(code: VoicePcmPlaybackError['code'], message: string) {
    super(message);
    this.name = 'VoicePcmPlaybackError';
    this.code = code;
  }
}

type DrainWaiter = Readonly<{
  resolve: () => void;
  reject: (error: VoicePcmPlaybackError) => void;
}>;

type PlaybackState = {
  readonly request: VoicePcmPlaybackRequest;
  readonly identity: VoicePcmPlaybackIdentity;
  readonly nativeModule: HappierAudioStreamNativePlaybackModule;
  drainedSubscription: Readonly<{ remove: () => void }> | null;
  levelSubscription: Readonly<{ remove: () => void }> | null;
  terminalSubscription: Readonly<{ remove: () => void }> | null;
  active: boolean;
  pendingOutput: boolean;
  terminalError: VoicePcmPlaybackError | null;
  readonly drainWaiters: DrainWaiter[];
  nativeStopAttempt: Promise<void> | null;
  releaseAttempt: Promise<void> | null;
};

function isPlaybackIdentity(value: VoicePcmPlaybackIdentity): boolean {
  return value.streamId.trim().length > 0
    && Number.isSafeInteger(value.generation)
    && value.generation > 0;
}

function validatePlaybackFormat(format: VoicePcmPlaybackFormat): void {
  if (
    !Number.isSafeInteger(format.sampleRate)
    || format.sampleRate <= 0
    || (format.channels !== 1 && format.channels !== 2)
    || !Number.isSafeInteger(format.maxBufferedMs)
    || format.maxBufferedMs <= 0
  ) {
    throw new VoicePcmPlaybackError(
      'invalid_playback_request',
      'PCM playback requires positive integer format values.',
    );
  }
}

function matchesIdentity(
  event: Pick<VoicePcmPlaybackIdentity, 'streamId' | 'generation'>,
  identity: VoicePcmPlaybackIdentity,
): boolean {
  return event.streamId === identity.streamId && event.generation === identity.generation;
}

function normalizeLevel(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(1, level));
}

function isPlaybackStartResult(
  value: unknown,
): value is Readonly<{ streamId: string; generation: number }> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.streamId === 'string'
    && typeof candidate.generation === 'number'
    && Number.isSafeInteger(candidate.generation)
    && candidate.generation > 0;
}

function getPlaybackModule(
  nativeModule: HappierAudioStreamNativeModule,
): HappierAudioStreamNativePlaybackModule {
  if (
    typeof nativeModule.startPlayback === 'function'
    && typeof nativeModule.enqueuePlayback === 'function'
    && typeof nativeModule.clearPlayback === 'function'
    && typeof nativeModule.stopPlayback === 'function'
    && typeof nativeModule.setPlaybackGain === 'function'
    && typeof nativeModule.getPlaybackCursorMs === 'function'
  ) {
    return nativeModule as HappierAudioStreamNativePlaybackModule;
  }
  throw new VoicePcmPlaybackError(
    'native_playback_unavailable',
    'The installed native audio module does not support PCM playback.',
  );
}

function nativeTerminalError(
  reason: AudioStreamPlaybackTerminalEvent['reason'],
): VoicePcmPlaybackError {
  return new VoicePcmPlaybackError(
    reason === 'write_error' ? 'native_playback_write_error' : 'native_playback_player_error',
    `native_pcm_playback_${reason}`,
  );
}

/**
 * The sole JavaScript owner for a native player attached to a live PCM capture
 * stream. Native methods provide the bounded queue; this wrapper provides
 * currentness, terminal signaling, and idempotent lifecycle semantics.
 */
export function createVoicePcmPlayback(options: Readonly<{
  nativeModule: HappierAudioStreamNativeModule;
  capture: Pick<VoicePcmCapture, 'getSnapshot'>;
}>): VoicePcmPlayback {
  let active: PlaybackState | null = null;
  let disposed = false;
  let mutationTail: Promise<void> = Promise.resolve();

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

  const reportError = (state: PlaybackState, error: VoicePcmPlaybackError): void => {
    try {
      state.request.onError?.(error);
    } catch {
      // Error observers cannot take over the player lifecycle.
    }
  };

  const reportLevel = (state: PlaybackState, level: unknown): void => {
    try {
      state.request.onOutputLevel?.(normalizeLevel(level));
    } catch {
      // Meters are observational only.
    }
  };

  const removeSubscriptions = (state: PlaybackState): void => {
    try {
      state.drainedSubscription?.remove();
    } finally {
      try {
        state.levelSubscription?.remove();
      } finally {
        state.terminalSubscription?.remove();
      }
    }
    state.drainedSubscription = null;
    state.levelSubscription = null;
    state.terminalSubscription = null;
  };

  const resolveDrainWaiters = (state: PlaybackState): void => {
    const waiters = state.drainWaiters.splice(0);
    waiters.forEach((waiter) => waiter.resolve());
  };

  const rejectDrainWaiters = (state: PlaybackState, error: VoicePcmPlaybackError): void => {
    const waiters = state.drainWaiters.splice(0);
    waiters.forEach((waiter) => waiter.reject(error));
  };

  const completeDrain = (state: PlaybackState): void => {
    if (!state.active || state.terminalError) return;
    state.pendingOutput = false;
    reportLevel(state, 0);
    resolveDrainWaiters(state);
  };

  const stopNative = (state: PlaybackState): Promise<void> => {
    if (!state.nativeStopAttempt) {
      state.nativeStopAttempt = state.nativeModule.stopPlayback({ ...state.identity });
    }
    return state.nativeStopAttempt;
  };

  const finishState = async (state: PlaybackState, terminalError?: VoicePcmPlaybackError): Promise<void> => {
    if (terminalError && !state.terminalError) {
      state.terminalError = terminalError;
      state.pendingOutput = false;
      rejectDrainWaiters(state, terminalError);
      reportLevel(state, 0);
      reportError(state, terminalError);
    } else if (!terminalError) {
      completeDrain(state);
    }
    state.active = false;
    if (active === state) active = null;
    removeSubscriptions(state);
    await stopNative(state);
  };

  const receiveTerminal = (state: PlaybackState, event: AudioStreamPlaybackTerminalEvent): void => {
    if (!state.active || state.terminalError || !matchesIdentity(event, state.identity)) return;
    const terminalError = nativeTerminalError(event.reason);
    // Native terminal events are observable synchronously by provider callbacks:
    // close the lease before queuing teardown so no late write can succeed.
    state.terminalError = terminalError;
    state.pendingOutput = false;
    rejectDrainWaiters(state, terminalError);
    reportLevel(state, 0);
    reportError(state, terminalError);
    state.active = false;
    if (active === state) active = null;
    void serialize(async () => {
      removeSubscriptions(state);
      await stopNative(state);
    }).catch(() => undefined);
  };

  const createLease = (state: PlaybackState): VoicePcmPlaybackLease => {
    const enqueue = (pcm16leBase64: string): boolean => {
      if (!state.active || state.terminalError || active !== state || pcm16leBase64.length === 0) return false;
      const wasPendingOutput = state.pendingOutput;
      state.pendingOutput = true;
      try {
        const result = state.nativeModule.enqueuePlayback({
          ...state.identity,
          pcm16leBase64,
        });
        if (!result.accepted) {
          state.pendingOutput = wasPendingOutput;
          return false;
        }
        reportLevel(state, result.level);
        return true;
      } catch {
        receiveTerminal(state, { ...state.identity, reason: 'write_error' });
        return false;
      }
    };

    const clear = (): void => {
      if (!state.active || state.terminalError || active !== state) return;
      try {
        state.nativeModule.clearPlayback({ ...state.identity });
        completeDrain(state);
      } catch {
        receiveTerminal(state, { ...state.identity, reason: 'write_error' });
      }
    };

    const setGain = (gain: number): boolean => {
      if (!state.active || state.terminalError || active !== state) return false;
      if (!Number.isFinite(gain) || gain < 0 || gain > 1) return false;
      try {
        state.nativeModule.setPlaybackGain({ ...state.identity, gain });
        return true;
      } catch {
        receiveTerminal(state, { ...state.identity, reason: 'player_error' });
        return false;
      }
    };

    const playbackCursorMs = (): number => {
      if (!state.active || state.terminalError || active !== state) return 0;
      try {
        const cursor = state.nativeModule.getPlaybackCursorMs({ ...state.identity });
        return typeof cursor === 'number' && Number.isFinite(cursor) && cursor >= 0
          ? Math.round(cursor)
          : 0;
      } catch {
        receiveTerminal(state, { ...state.identity, reason: 'player_error' });
        return 0;
      }
    };

    const waitForDrain = (): Promise<void> => {
      if (state.terminalError) return Promise.reject(state.terminalError);
      if (!state.active || !state.pendingOutput) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        state.drainWaiters.push({ resolve, reject });
      });
    };

    const release = async (): Promise<void> => {
      if (state.releaseAttempt) return state.releaseAttempt;
      state.releaseAttempt = serialize(async () => {
        if (!state.active && active !== state) {
          await stopNative(state);
          return;
        }
        await finishState(state);
      });
      return state.releaseAttempt;
    };

    return {
      ...state.identity,
      enqueue,
      clear,
      setGain,
      playbackCursorMs,
      waitForDrain,
      release,
    };
  };

  const open = async (request: VoicePcmPlaybackRequest): Promise<VoicePcmPlaybackLease> => {
    if (!isPlaybackIdentity(request.capture)) {
      throw new VoicePcmPlaybackError(
        'invalid_playback_request',
        'PCM playback requires a non-empty capture stream and positive generation.',
      );
    }
    validatePlaybackFormat(request.format);
    return serialize(async () => {
      if (disposed) {
        throw new VoicePcmPlaybackError('voice_pcm_playback_disposed', 'The PCM playback service has been disposed.');
      }
      if (active) {
        throw new VoicePcmPlaybackError(
          'playback_stream_conflict',
          'A native PCM playback stream is already active.',
        );
      }
      const snapshot = options.capture.getSnapshot();
      if (
        snapshot.streamId !== request.capture.streamId
        || snapshot.generation !== request.capture.generation
      ) {
        throw new VoicePcmPlaybackError(
          'playback_capture_mismatch',
          'PCM playback must attach to the current native capture stream.',
        );
      }
      const nativeModule = getPlaybackModule(options.nativeModule);
      const state: PlaybackState = {
        request,
        identity: { ...request.capture },
        nativeModule,
        drainedSubscription: null,
        levelSubscription: null,
        terminalSubscription: null,
        active: true,
        pendingOutput: false,
        terminalError: null,
        drainWaiters: [],
        nativeStopAttempt: null,
        releaseAttempt: null,
      };
      active = state;
      state.drainedSubscription = nativeModule.addListener('playbackDrained', (event: AudioStreamPlaybackDrainedEvent) => {
        if (matchesIdentity(event, state.identity)) completeDrain(state);
      });
      state.levelSubscription = nativeModule.addListener('playbackLevel', (event: AudioStreamPlaybackLevelEvent) => {
        if (state.active && !state.terminalError && matchesIdentity(event, state.identity)) {
          reportLevel(state, event.level);
        }
      });
      state.terminalSubscription = nativeModule.addListener('playbackTerminal', (event: AudioStreamPlaybackTerminalEvent) => {
        receiveTerminal(state, event);
      });
      try {
        const started = await nativeModule.startPlayback({
          ...state.identity,
          ...request.format,
        });
        if (!isPlaybackStartResult(started) || !matchesIdentity(started, state.identity)) {
          throw new VoicePcmPlaybackError(
            'playback_capture_mismatch',
            'Native PCM playback started against a different capture stream.',
          );
        }
        if (state.terminalError) throw state.terminalError;
        return createLease(state);
      } catch (error) {
        state.active = false;
        if (active === state) active = null;
        removeSubscriptions(state);
        try {
          await stopNative(state);
        } catch {
          // The startup error remains the actionable failure.
        }
        if (error instanceof VoicePcmPlaybackError) throw error;
        throw new VoicePcmPlaybackError('native_playback_start_failed', 'Native PCM playback could not start.');
      }
    });
  };

  return {
    open,
    dispose: async () => {
      disposed = true;
      await serialize(async () => {
        const current = active;
        if (current) await finishState(current);
      });
    },
  };
}
