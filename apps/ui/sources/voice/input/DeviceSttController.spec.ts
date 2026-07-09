import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));
const webVadState = vi.hoisted(() => ({
  onSpeechEnd: null as null | (() => void),
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
      adapters: {
        local_direct: {
          stt: { provider: 'device', useDeviceStt: true },
          handsFree: {
            enabled: handsFreeEnabled,
            ...(endpointing === null ? {} : { endpointing: endpointing ?? { silenceMs: 0, minSpeechMs: 0 } }),
          },
        },
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
  });

  afterEach(() => {
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

  it('uses finalized transcript endpointing as a fallback while web VAD is active', async () => {
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

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'heuristic',
      transcript: 'vad backed transcript',
    }));

    webVadState.onSpeechEnd?.();
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      source: 'web_vad',
      transcript: '',
    }));
  });

  it('uses finalized transcript endpointing as a fallback while native VAD is active', async () => {
    const onEndpointSignal = vi.fn();
    const nativeVadController = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => true),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, { silenceMs: 30, minSpeechMs: 10 }),
      nativeVadController,
      onEndpointSignal,
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });
    listeners.result?.({ results: [{ transcript: 'native vad backed transcript' }], isFinal: true });

    expect(nativeVadController.startSession).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      minSpeechMs: 10,
      redemptionMs: 30,
    });
    await vi.waitFor(() => {
      expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
        source: 'heuristic',
        transcript: 'native vad backed transcript',
      }));
    });
  });

  it('uses the current hands-free endpointing defaults when endpointing settings are missing', async () => {
    const nativeVadController = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => false),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, null),
      nativeVadController,
      onEndpointSignal: vi.fn(),
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });

    expect(nativeVadController.startSession).toHaveBeenCalledWith({
      sessionId: expect.any(String),
      minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      redemptionMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
    });
  });

  it('ensures the injected mic session is active before starting device STT (single acquisition)', async () => {
    const micSession = createMicSession();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession, sink: createSink() });

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalled();
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

  it('falls back to finalized transcript endpointing when native VAD is unavailable', async () => {
    const onEndpointSignal = vi.fn();
    const nativeVadController = {
      isActiveSession: vi.fn(() => false),
      startSession: vi.fn(async () => false),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true),
      nativeVadController,
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
  });

  it('surfaces device STT startup failures through a typed sink error and rethrows', async () => {
    start.mockImplementationOnce(() => {
      throw new Error('speech_start_failed');
    });
    const sink = createSink();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ micSession: createMicSession(), sink })).rejects.toThrow('speech_start_failed');
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'device_stt_start_failed',
    }));
  });

  it('stops the in-flight recognizer promptly when the D8 abort signal fires mid-recognition', async () => {
    start.mockClear();
    stop.mockClear();
    const sink = createSink();
    const abortController = new AbortController();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink, signal: abortController.signal });

    // Recognizer is running: an interim result has streamed in but no stop yet.
    listeners.audiostart?.({});
    listeners.result?.({ results: [{ transcript: 'partial in flight' }], isFinal: false });
    expect(stop).not.toHaveBeenCalled();

    // Firing the abort signal mid-recognition must stop the recognizer promptly
    // (the contract requires aborting in-flight work, not only the entry check).
    abortController.abort();
    expect(stop).toHaveBeenCalledTimes(1);

    // The in-flight turn ends without hanging on the stop timeout.
    await expect(controller.stop()).resolves.toEqual({ finalText: 'partial in flight' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not start a recognizer when the abort signal fires during async setup', async () => {
    start.mockClear();
    const sink = createSink();
    const abortController = new AbortController();
    const micSession = createMicSession();
    // Abort while ensureActive() is in flight, before the recognizer starts.
    (micSession.ensureActive as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      abortController.abort();
    });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession, sink, signal: abortController.signal });

    expect(start).not.toHaveBeenCalled();
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

    // A late abort after completion must not reach the torn-down recognizer.
    stop.mockClear();
    abortController.abort();
    expect(stop).not.toHaveBeenCalled();
  });
});
