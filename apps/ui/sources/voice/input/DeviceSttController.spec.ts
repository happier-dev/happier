import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';
import { createTurnEndpointController } from '@/voice/runtime/input/TurnEndpointController';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));
const webVadState = vi.hoisted(() => ({
  onSpeechEnd: null as null | (() => void),
}));
const acquireAudioSession = vi.hoisted(() => vi.fn());
const releaseAudioSession = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@happier-dev/audio-stream-native', () => ({
  getSharedVoiceAudioSessionCoordinator: () => ({ acquire: acquireAudioSession }),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
    },
  });
});

const requestMicrophonePermission = vi.fn(async () => ({ granted: true, canAskAgain: true }));
const showMicrophonePermissionDeniedAlert = vi.fn();

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission,
  showMicrophonePermissionDeniedAlert,
}));

const addListener = vi.fn((eventName: string, cb: (event: any) => void) => {
  listeners[eventName] = cb;
  return { remove: vi.fn() };
});
const start = vi.fn();
const stop = vi.fn();
const requestPermissionsAsync = vi.fn(async () => ({ granted: true }));
const isRecognitionAvailable = vi.fn(() => true);
const listeners: Record<string, (event: any) => void> = {};

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    addListener,
    start,
    stop,
    requestPermissionsAsync,
    isRecognitionAvailable,
  },
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async (options: { onSpeechEnd?: () => void }) => {
      webVadState.onSpeechEnd = typeof options.onSpeechEnd === 'function' ? options.onSpeechEnd : null;
      return {
        pause: vi.fn(),
        start: vi.fn(),
      };
    }),
  },
}));

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function observeSettledPromptly(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function captureSynchronousError(callback: () => void): unknown | null {
  try {
    callback();
    return null;
  } catch (error) {
    return error;
  }
}

function createSynchronousAbortHarness(): Readonly<{
  abort: () => void;
  signal: AbortSignal;
}> {
  let aborted = false;
  const listeners = new Set<EventListenerOrEventListenerObject>();
  // Genuine platform-boundary fixture: the controller only consumes this
  // AbortSignal subset, and synchronous dispatch keeps observer failures
  // attributable to the triggering assertion.
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'abort') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'abort') listeners.delete(listener);
    },
  } as unknown as AbortSignal;

  return {
    signal,
    abort: () => {
      if (aborted) return;
      aborted = true;
      const event = new Event('abort');
      for (const listener of [...listeners]) {
        if (typeof listener === 'function') {
          listener.call(signal, event);
        } else {
          listener.handleEvent(event);
        }
      }
    },
  };
}

function createMicSession(): MicSession {
  return {
    ensureActive: vi.fn(async () => {}),
    setMuted: vi.fn(),
    isMuted: vi.fn(() => false),
    teardown: vi.fn(async () => {}),
    getStream: vi.fn(() => null),
    getAudioContext: vi.fn(() => null),
  };
}

function createSink(): SttSink & {
  onAudioStarted: ReturnType<typeof vi.fn>;
  onPartial: ReturnType<typeof vi.fn>;
  onFinal: ReturnType<typeof vi.fn>;
  onEndpoint: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  return {
    onAudioStarted: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onEndpoint: vi.fn(),
    onError: vi.fn(),
  };
}

function baseSettings(handsFreeEnabled: boolean, endpointing?: { silenceMs: number; minSpeechMs: number } | null) {
  return {
    voice: {
      providerId: 'local_direct',
      assistantLanguage: 'en',
      providers: {
        local_direct: { schemaVersion: 1, config: {
          stt: { provider: 'device', useDeviceStt: true },
          handsFree: {
            enabled: handsFreeEnabled,
            ...(endpointing === null ? {} : { endpointing: endpointing ?? { silenceMs: 0, minSpeechMs: 0 } }),
          },
        } },
      },
    },
  };
}

describe('createDeviceSttController', () => {
  const previousWindow = (globalThis as { window?: object }).window;
  const previousDocument = (globalThis as { document?: object }).document;

  beforeEach(() => {
    platformOsMock.value = 'ios';
    webVadState.onSpeechEnd = null;
    releaseAudioSession.mockReset();
    releaseAudioSession.mockResolvedValue(undefined);
    acquireAudioSession.mockReset();
    acquireAudioSession.mockResolvedValue({
      id: 'device-stt-audio-session',
      capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
      release: releaseAudioSession,
    });
  });

  afterEach(() => {
    vi.useRealTimers();

    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis as object, 'window');
    } else {
      (globalThis as { window?: object }).window = previousWindow;
    }

    if (previousDocument === undefined) {
      Reflect.deleteProperty(globalThis as object, 'document');
    } else {
      (globalThis as { document?: object }).document = previousDocument;
    }
  });

  it('demotes web speech recognition to single-utterance (non-continuous) mode', async () => {
    platformOsMock.value = 'web';
    start.mockClear();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink: createSink() });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ continuous: false }));
  });

  it('surfaces interim transcripts via onPartial and the committed transcript via onFinal', async () => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink });

    listeners.result?.({ results: [{ transcript: ' hello ' }], isFinal: false });
    expect(sink.onAudioStarted).toHaveBeenCalledTimes(1);
    expect(sink.onPartial).toHaveBeenCalledWith('hello');

    listeners.result?.({ results: [{ transcript: ' hello world ' }], isFinal: true });
    expect(sink.onFinal).toHaveBeenCalledWith('hello world');
  });

  it('emits runtime-owned heuristic endpoint signals for finalized device transcripts', async () => {
    const onEndpointSignal = vi.fn();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), onEndpointSignal });

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({ results: [{ transcript: ' hello runtime ' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
      transcript: 'hello runtime',
      sessionId: expect.any(String),
    }));
  });

  it('uses web VAD as the primary endpoint while its session is active', async () => {
    platformOsMock.value = 'web';
    (globalThis as { window?: object }).window = {};
    (globalThis as { document?: object }).document = {};
    const onEndpointSignal = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    // WebVadController is platform-split (WebVadController.ts is the native-safe
    // no-op fallback; WebVadController.web.ts holds the real `@ricky0123/vad-web`
    // integration this test simulates). Metro resolves the `.web` file for real
    // web builds, but Vitest has no such platform resolution — inject the real
    // web implementation explicitly to exercise it under the simulated DOM.
    const { createWebVadController } = await import('@/voice/runtime/input/WebVadController.web');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true),
      onEndpointSignal,
      webVadController: createWebVadController({ onEndpointSignal }),
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({ results: [{ transcript: 'vad backed transcript' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).not.toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
    }));

    webVadState.onSpeechEnd?.();
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'web_vad',
      transcript: '',
    }));
  });

  it('uses recognizer facts for native candidates without starting host VAD or host PCM capture', async () => {
    const onEndpointSignal = vi.fn();
    const onSpeechCandidateStart = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, { silenceMs: 30, minSpeechMs: 10 }),
      onEndpointSignal,
      onSpeechCandidateStart,
    });

    const micSession = createMicSession();
    await controller.start({ micSession, sink: createSink() });
    listeners.speechstart?.({});
    listeners.result?.({ results: [{ transcript: 'native vad backed transcript' }], isFinal: true });

    expect(acquireAudioSession).toHaveBeenCalledWith({
      ownerId: expect.stringMatching(/^device-stt:/),
      mode: 'dictation', input: true, output: false, aec: 'off',
      capture: 'provider_managed_exclusive',
    });
    expect(micSession.ensureActive).not.toHaveBeenCalled();
    expect(onSpeechCandidateStart).toHaveBeenCalledWith({
      sessionId: expect.any(String), source: 'device_recognizer',
    });
    await vi.waitFor(() => {
      expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
        source: 'heuristic',
        transcript: 'native vad backed transcript',
      }));
    });
  });

  it('uses the current hands-free endpointing defaults for the web-owned VAD stream', async () => {
    platformOsMock.value = 'web';
    (globalThis as { window?: object }).window = {};
    (globalThis as { document?: object }).document = {};
    const webVadController = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => true),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, null),
      webVadController,
      onEndpointSignal: vi.fn(),
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });

    expect(webVadController.startSession).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      redemptionMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
      micSession: expect.any(Object),
    });
  });

  it('holds exactly one provider-exclusive lease and releases it once on explicit stop', async () => {
    const micSession = createMicSession();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });

    await controller.start({ micSession, sink: createSink() });

    expect(micSession.ensureActive).not.toHaveBeenCalled();
    expect(acquireAudioSession).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalled();

    await controller.stop();
    await controller.stop();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a second start instead of replacing the active exclusive lease', async () => {
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    await controller.start(params);
    await expect(controller.start(params)).rejects.toThrow('device_stt_already_started');
    expect(acquireAudioSession).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('reserves native admission before awaiting the exclusive lease', async () => {
    start.mockClear();
    addListener.mockClear();
    const deferredLease = createDeferred<{
      id: string;
      capabilities: { aecAvailable: boolean; aecActive: boolean; route: string };
      release: typeof releaseAudioSession;
    }>();
    acquireAudioSession.mockReturnValueOnce(deferredLease.promise);
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    const firstStart = controller.start(params);
    await vi.waitFor(() => expect(acquireAudioSession).toHaveBeenCalledTimes(1));
    const concurrentStart = controller.start(params);

    await expect(concurrentStart).rejects.toThrow('device_stt_already_started');
    expect(acquireAudioSession).toHaveBeenCalledTimes(1);
    deferredLease.resolve({
      id: 'deferred-native-lease',
      capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
      release: releaseAudioSession,
    });
    await firstStart;

    expect(start).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(6);
    await controller.stop();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('cancels and clears a native start reservation when stop wins during lease acquisition', async () => {
    start.mockClear();
    addListener.mockClear();
    const deferredLease = createDeferred<{
      id: string;
      capabilities: { aecAvailable: boolean; aecActive: boolean; route: string };
      release: typeof releaseAudioSession;
    }>();
    acquireAudioSession.mockReturnValueOnce(deferredLease.promise);
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    const starting = controller.start(params);
    await vi.waitFor(() => expect(acquireAudioSession).toHaveBeenCalledTimes(1));
    const stopping = controller.stop();
    deferredLease.resolve({
      id: 'cancelled-native-lease',
      capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
      release: releaseAudioSession,
    });

    await expect(starting).resolves.toBeUndefined();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(start).not.toHaveBeenCalled();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);

    await expect(controller.start(params)).resolves.toBeUndefined();
    expect(acquireAudioSession).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(releaseAudioSession).toHaveBeenCalledTimes(2);
  });

  it('settles stop while native acquisition is pending and releases the late lease', async () => {
    start.mockClear();
    const deferredLease = createDeferred<{
      id: string;
      capabilities: { aecAvailable: boolean; aecActive: boolean; route: string };
      release: typeof releaseAudioSession;
    }>();
    acquireAudioSession.mockReturnValueOnce(deferredLease.promise);
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    const starting = controller.start({ micSession: createMicSession(), sink: createSink() });
    await vi.waitFor(() => expect(acquireAudioSession).toHaveBeenCalledTimes(1));
    const stopping = controller.stop();
    const stoppedBeforeAcquire = await observeSettledPromptly(stopping);

    deferredLease.resolve({
      id: 'late-stop-lease',
      capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
      release: releaseAudioSession,
    });
    await starting;
    await stopping;
    await flushMicrotasks();

    expect(stoppedBeforeAcquire).toBe(true);
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('reserves web admission before awaiting the shared browser mic', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    addListener.mockClear();
    const deferredMic = createDeferred<void>();
    const micSession = createMicSession();
    (micSession.ensureActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(deferredMic.promise);
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession, sink: createSink() };

    const firstStart = controller.start(params);
    await vi.waitFor(() => expect(micSession.ensureActive).toHaveBeenCalledTimes(1));
    const concurrentStart = controller.start(params);

    await expect(concurrentStart).rejects.toThrow('device_stt_already_started');
    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(acquireAudioSession).not.toHaveBeenCalled();
    deferredMic.resolve();
    await firstStart;

    expect(start).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(6);
    listeners.end?.({});
    await controller.stop();
  });

  it('uses recognizer no-match as a candidate false alarm', async () => {
    const onSpeechCandidateStart = vi.fn();
    const onSpeechCandidateFalseAlarm = vi.fn();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      onSpeechCandidateStart,
      onSpeechCandidateFalseAlarm,
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    listeners.speechstart?.({});
    listeners.nomatch?.({});

    expect(onSpeechCandidateStart).toHaveBeenCalledTimes(1);
    expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledWith({
      sessionId: expect.any(String), source: 'device_recognizer',
    });
    listeners.end?.({});
    await controller.stop();
  });

  it('requires a mic session before starting device STT capture', async () => {
    requestMicrophonePermission.mockClear();
    start.mockClear();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ sink: createSink() } as never)).rejects.toThrow('mic_session_required');
    expect(requestMicrophonePermission).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('uses finalized transcript endpointing for native recognition without host VAD', async () => {
    const onEndpointSignal = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true),
      onEndpointSignal,
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({ results: [{ transcript: 'native fallback transcript' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
      transcript: 'native fallback transcript',
    }));
  });

  it('surfaces an unavailable recognizer through a typed sink error instead of throwing', async () => {
    isRecognitionAvailable.mockReturnValueOnce(false);
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink });

    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'device_stt_unavailable',
    }));
    const reportedFailure = sink.onError.mock.calls[0]?.[0];
    const stopResult = await controller.stop();

    expect(stopResult).toEqual({ error: reportedFailure });
  });

  it('surfaces device STT startup failures through a typed sink error and rethrows', async () => {
    start.mockImplementationOnce(() => {
      throw new Error('speech_start_failed');
    });
    const sink = createSink();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });

    await expect(controller.start({ micSession: createMicSession(), sink })).rejects.toThrow('speech_start_failed');
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'device_stt_start_failed',
    }));
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);

    await expect(controller.start({ micSession: createMicSession(), sink })).resolves.toBeUndefined();
    await controller.stop();
    expect(acquireAudioSession).toHaveBeenCalledTimes(2);
    expect(releaseAudioSession).toHaveBeenCalledTimes(2);
  });

  it('releases the exclusive native lease when recognizer listener setup fails', async () => {
    addListener.mockImplementationOnce(() => {
      throw new Error('listener_setup_failed');
    });
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ micSession: createMicSession(), sink })).rejects.toThrow('listener_setup_failed');

    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error', reason: 'device_stt_start_failed',
    }));
  });

  it('settles a recognizer error promptly and releases its lease once when candidate observers throw', async () => {
    vi.useFakeTimers();
    stop.mockClear();
    const sink = createSink();
    const onSpeechCandidateStart = vi.fn(() => {
      throw new Error('broken_candidate_start_observer');
    });
    const onSpeechCandidateFalseAlarm = vi.fn(() => {
      throw new Error('broken_candidate_false_alarm_observer');
    });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      onSpeechCandidateStart,
      onSpeechCandidateFalseAlarm,
      stopTimeoutMs: 75,
    });

    await controller.start({ micSession: createMicSession(), sink });
    const candidateObserverError = captureSynchronousError(() => listeners.speechstart?.({}));
    const terminalObserverError = captureSynchronousError(() => listeners.error?.({ error: 'network' }));
    let stopSettled = false;
    const stopping = controller.stop().then((result) => {
      stopSettled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeStopTimeout = stopSettled;
    await vi.advanceTimersByTimeAsync(75);
    const result = await stopping;

    expect(candidateObserverError).toBeNull();
    expect(terminalObserverError).toBeNull();
    expect(settledBeforeStopTimeout).toBe(true);
    expect(result).toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'network',
      }),
    });
    expect(onSpeechCandidateStart).toHaveBeenCalledTimes(1);
    expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledTimes(1);
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('publishes a recognizer error only after its exclusive audio lease settles', async () => {
    const releaseSettled = createDeferred<void>();
    releaseAudioSession.mockImplementationOnce(() => releaseSettled.promise);
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });
    await controller.start({ micSession: createMicSession(), sink });

    listeners.error?.({ error: 'network' });
    let stopFinished = false;
    const stopping = controller.stop().then((result) => {
      stopFinished = true;
      return result;
    });
    await flushMicrotasks();

    expect(sink.onError).not.toHaveBeenCalled();
    expect(stopFinished).toBe(false);

    releaseSettled.resolve();
    await expect(stopping).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'network',
      }),
    });
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'network',
    }));
  });

  it('does not promote the last partial when the recognizer ends naturally without an authoritative final', async () => {
    const sink = createSink();
    const onEndpointSignal = vi.fn();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      onEndpointSignal,
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.result?.({ results: [{ transcript: 'natural recognizer end' }], isFinal: false });
    listeners.end?.({});
    await flushMicrotasks();

    expect(sink.onPartial).toHaveBeenCalledWith('natural recognizer end');
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(onEndpointSignal).not.toHaveBeenCalled();
    await expect(controller.stop()).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'device_stt_finalization_failed',
      }),
    });
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('does not return an interim transcript when manual stop ends without an authoritative final', async () => {
    const sink = createSink();
    const onEndpointSignal = vi.fn();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      onEndpointSignal,
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.result?.({ results: [{ transcript: 'manual stop partial' }], isFinal: false });

    const stopping = controller.stop();
    listeners.end?.({});

    await expect(stopping).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'device_stt_finalization_failed',
      }),
    });
    expect(sink.onPartial).toHaveBeenCalledWith('manual stop partial');
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(onEndpointSignal).not.toHaveBeenCalled();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('still releases the exclusive lease when a terminal sink observer throws', async () => {
    const sink = createSink();
    sink.onFinal.mockImplementationOnce(() => {
      throw new Error('broken_sink_observer');
    });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink });
    expect(() => listeners.result?.({
      results: [{ transcript: 'authoritative final' }],
      isFinal: true,
    })).not.toThrow();

    expect(() => listeners.end?.({})).not.toThrow();
    await flushMicrotasks();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('preserves and returns every authoritative final segment in provider order', async () => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.result?.({
      results: [{ transcript: 'first' }],
      isFinal: true,
    });
    listeners.result?.({
      results: [{ transcript: ' second ' }],
      isFinal: true,
    });
    listeners.end?.({});
    await flushMicrotasks();

    expect(sink.onFinal).toHaveBeenLastCalledWith('first second');
    await expect(controller.stop()).resolves.toEqual({
      finalText: 'first second',
    });
  });

  it('ignores queued callbacks from a stopped generation after the next capture starts', async () => {
    const firstSink = createSink();
    const secondSink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      stopTimeoutMs: 0,
    });

    await controller.start({ micSession: createMicSession(), sink: firstSink });
    const firstCallbacks = {
      end: listeners.end,
      error: listeners.error,
      result: listeners.result,
    };
    await controller.stop();

    firstSink.onAudioStarted.mockClear();
    firstSink.onPartial.mockClear();
    firstSink.onFinal.mockClear();
    firstSink.onEndpoint.mockClear();
    firstSink.onError.mockClear();

    await controller.start({ micSession: createMicSession(), sink: secondSink });
    const secondEnd = listeners.end;

    firstCallbacks.result?.({
      results: [{ transcript: 'stale first capture' }],
      isFinal: true,
    });
    firstCallbacks.error?.({ error: 'network' });
    firstCallbacks.end?.({});
    await flushMicrotasks();
    await flushMicrotasks();

    secondEnd?.({});
    await controller.stop();

    expect(firstSink.onAudioStarted).not.toHaveBeenCalled();
    expect(firstSink.onPartial).not.toHaveBeenCalled();
    expect(firstSink.onFinal).not.toHaveBeenCalled();
    expect(firstSink.onEndpoint).not.toHaveBeenCalled();
    expect(firstSink.onError).not.toHaveBeenCalled();
    expect(secondSink.onPartial).not.toHaveBeenCalled();
    expect(secondSink.onFinal).not.toHaveBeenCalled();
    expect(secondSink.onEndpoint).not.toHaveBeenCalled();
    expect(secondSink.onError).not.toHaveBeenCalled();
  });

  it('normalizes no-speech, speech-timeout, and no-match to one empty terminal outcome', async () => {
    const { createDeviceSttController } = await import('./DeviceSttController');

    for (const outcome of ['no-speech', 'speech-timeout', 'nomatch'] as const) {
      const sink = createSink();
      const controller = createDeviceSttController({
        getSettings: () => baseSettings(false),
      });

      await controller.start({ micSession: createMicSession(), sink });
      if (outcome === 'nomatch') {
        listeners.nomatch?.({});
        listeners.end?.({});
      } else {
        listeners.error?.({ error: outcome });
      }

      await expect(controller.stop()).resolves.toEqual({ finalText: '' });
      expect(sink.onError).not.toHaveBeenCalled();
    }
  });

  it('uses the same typed provider failure for the error sink and terminal stop result', async () => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.error?.({ error: 'network' });

    await expect(controller.stop()).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'network',
      }),
    });
    expect(sink.onError).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'network',
    }));
  });

  it('keeps an authoritative final successful when a trailing provider error arrives', async () => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.result?.({
      results: [{ transcript: 'committed before provider teardown' }],
      isFinal: true,
    });
    listeners.error?.({ error: 'network' });

    await expect(controller.stop()).resolves.toEqual({
      finalText: 'committed before provider teardown',
    });
    expect(sink.onError).not.toHaveBeenCalled();
  });

  it('uses finalized-transcript endpointing only when web VAD fails to start', async () => {
    platformOsMock.value = 'web';
    (globalThis as { window?: object }).window = {};
    (globalThis as { document?: object }).document = {};
    const vadBackedEndpoint = vi.fn();
    const fallbackEndpoint = vi.fn();
    const successfulVad = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => true),
      stopSession: vi.fn(async () => {}),
    };
    const failedVad = {
      isActiveSession: vi.fn(() => false),
      startSession: vi.fn(async () => false),
      stopSession: vi.fn(async () => {}),
    };
    const { createDeviceSttController } = await import('./DeviceSttController');

    const vadBackedController = createDeviceSttController({
      getSettings: () => baseSettings(true),
      onEndpointSignal: vadBackedEndpoint,
      webVadController: successfulVad,
    });
    await vadBackedController.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({
      results: [{ transcript: 'wait for acoustic endpoint' }],
      isFinal: true,
    });
    await flushMicrotasks();
    listeners.end?.({});
    await vadBackedController.stop();

    const fallbackController = createDeviceSttController({
      getSettings: () => baseSettings(true),
      onEndpointSignal: fallbackEndpoint,
      webVadController: failedVad,
    });
    await fallbackController.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({
      results: [{ transcript: 'heuristic fallback' }],
      isFinal: true,
    });
    await flushMicrotasks();
    listeners.end?.({});
    await fallbackController.stop();

    expect(vadBackedEndpoint).not.toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
    }));
    expect(fallbackEndpoint).toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
      transcript: 'heuristic fallback',
    }));
  });

  it('settles an abort during microphone permission before native acquisition begins', async () => {
    start.mockClear();
    const permission = createDeferred<{ granted: boolean; canAskAgain: boolean }>();
    requestMicrophonePermission.mockReturnValueOnce(permission.promise);
    const abortController = new AbortController();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
    });

    const starting = controller.start({
      micSession: createMicSession(),
      sink: createSink(),
      signal: abortController.signal,
    });
    await flushMicrotasks();
    abortController.abort();
    const settledBeforePermission = await observeSettledPromptly(starting);

    permission.resolve({ granted: true, canAskAgain: true });
    await starting;

    expect(settledBeforePermission).toBe(true);
    expect(acquireAudioSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during native coordinator acquisition and releases a late lease', async () => {
    start.mockClear();
    const lease = createDeferred<{
      id: string;
      capabilities: { aecAvailable: boolean; aecActive: boolean; route: string };
      release: typeof releaseAudioSession;
    }>();
    const acquire = vi.fn(() => lease.promise);
    const abortController = new AbortController();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      getAudioSessionCoordinator: () => ({ acquire } as never),
    });

    const starting = controller.start({
      micSession: createMicSession(),
      sink: createSink(),
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
    abortController.abort();
    const settledBeforeAcquire = await observeSettledPromptly(starting);

    lease.resolve({
      id: 'late-aborted-lease',
      capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
      release: releaseAudioSession,
    });
    await starting;
    await flushMicrotasks();

    expect(settledBeforeAcquire).toBe(true);
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during browser mic acquisition without starting VAD or recognition', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    const micReady = createDeferred<void>();
    const micSession = createMicSession();
    (micSession.ensureActive as ReturnType<typeof vi.fn>).mockReturnValueOnce(micReady.promise);
    const webVadController = {
      isActiveSession: vi.fn(() => false),
      startSession: vi.fn(async () => true),
      stopSession: vi.fn(async () => {}),
    };
    const abortController = new AbortController();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      webVadController,
    });

    const starting = controller.start({
      micSession,
      sink: createSink(),
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(micSession.ensureActive).toHaveBeenCalledTimes(1));
    abortController.abort();
    const settledBeforeMic = await observeSettledPromptly(starting);

    micReady.resolve();
    await starting;

    expect(settledBeforeMic).toBe(true);
    expect(webVadController.startSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during web VAD startup without starting recognition', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    const vadReady = createDeferred<boolean>();
    const webVadController = {
      isActiveSession: vi.fn(() => false),
      startSession: vi.fn(() => vadReady.promise),
      stopSession: vi.fn(async () => {}),
    };
    const abortController = new AbortController();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      webVadController,
    });

    const starting = controller.start({
      micSession: createMicSession(),
      sink: createSink(),
      signal: abortController.signal,
    });
    await vi.waitFor(() => expect(webVadController.startSession).toHaveBeenCalledTimes(1));
    abortController.abort();
    const settledBeforeVad = await observeSettledPromptly(starting);

    vadReady.resolve(true);
    await starting;

    expect(settledBeforeVad).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('keeps endpoint settlement and cleanup authoritative when transcript and endpoint observers throw', async () => {
    const sink = createSink();
    const onEndpointSignal = vi.fn(() => {
      throw new Error('broken_runtime_endpoint_observer');
    });
    sink.onFinal.mockImplementationOnce(() => {
      throw new Error('broken_final_observer');
    });
    sink.onEndpoint.mockImplementationOnce(() => {
      throw new Error('broken_sink_endpoint_observer');
    });
    const endpointController = createTurnEndpointController({
      onSignal: onEndpointSignal,
      queueTask: (task) => task(),
    });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      endpointController,
    });

    await controller.start({ micSession: createMicSession(), sink });
    const endpointObserverError = captureSynchronousError(() => listeners.result?.({
      results: [{ transcript: 'authoritative despite observer failure' }],
      isFinal: true,
    }));
    listeners.end?.({});
    const result = await controller.stop();

    expect(endpointObserverError).toBeNull();
    expect(result).toEqual({ finalText: 'authoritative despite observer failure' });
    expect(sink.onEndpoint).toHaveBeenCalledWith('silence');
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
      transcript: 'authoritative despite observer failure',
    }));
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('stops and settles an in-flight abort promptly when candidate observers throw', async () => {
    vi.useFakeTimers();
    start.mockClear();
    stop.mockClear();
    const sink = createSink();
    const abortHarness = createSynchronousAbortHarness();
    const onSpeechCandidateStart = vi.fn(() => {
      throw new Error('broken_candidate_start_observer');
    });
    const onSpeechCandidateFalseAlarm = vi.fn(() => {
      throw new Error('broken_candidate_false_alarm_observer');
    });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      onSpeechCandidateStart,
      onSpeechCandidateFalseAlarm,
      stopTimeoutMs: 75,
    });

    await controller.start({ micSession: createMicSession(), sink, signal: abortHarness.signal });

    // Recognizer is running: an interim result has streamed in but no stop yet.
    listeners.audiostart?.({});
    const candidateObserverError = captureSynchronousError(() => listeners.speechstart?.({}));
    listeners.result?.({ results: [{ transcript: 'partial in flight' }], isFinal: false });
    expect(stop).not.toHaveBeenCalled();

    // Firing the abort signal mid-recognition must stop the recognizer promptly
    // (the contract requires aborting in-flight work, not only the entry check).
    const abortObserverError = captureSynchronousError(abortHarness.abort);
    let stopSettled = false;
    const stopping = controller.stop().then((result) => {
      stopSettled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    const settledBeforeStopTimeout = stopSettled;
    await vi.advanceTimersByTimeAsync(75);
    const result = await stopping;

    // The in-flight turn ends without hanging on the stop timeout or promoting
    // the provisional words that existed when cancellation won.
    expect(candidateObserverError).toBeNull();
    expect(abortObserverError).toBeNull();
    expect(settledBeforeStopTimeout).toBe(true);
    expect(result).toEqual({
      error: expect.objectContaining({
        kind: 'turn_aborted',
        reason: 'turn_aborted',
      }),
    });
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(onSpeechCandidateStart).toHaveBeenCalledTimes(1);
    expect(onSpeechCandidateFalseAlarm).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
  });

  it('does not start a recognizer when the abort signal fires during async setup', async () => {
    start.mockClear();
    const sink = createSink();
    const abortController = new AbortController();
    const micSession = createMicSession();
    // Abort while the provider-exclusive lease is being acquired, before the recognizer starts.
    acquireAudioSession.mockImplementationOnce(async () => {
      abortController.abort();
      return {
        id: 'device-stt-audio-session',
        capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
        release: releaseAudioSession,
      };
    });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession, sink, signal: abortController.signal });

    expect(start).not.toHaveBeenCalled();
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);
    await expect(controller.stop()).resolves.toEqual({
      error: expect.objectContaining({
        kind: 'turn_aborted',
        reason: 'turn_aborted',
      }),
    });
  });

  it('removes the abort listener when the turn completes so the signal does not leak', async () => {
    start.mockClear();
    stop.mockClear();
    const sink = createSink();
    const abortController = new AbortController();
    const removeSpy = vi.spyOn(abortController.signal, 'removeEventListener');

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });

    await controller.start({ micSession: createMicSession(), sink, signal: abortController.signal });
    listeners.end?.({});
    await controller.stop();

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(releaseAudioSession).toHaveBeenCalledTimes(1);

    // A late abort after completion must not reach the torn-down recognizer.
    stop.mockClear();
    abortController.abort();
    expect(stop).not.toHaveBeenCalled();
  });
});
