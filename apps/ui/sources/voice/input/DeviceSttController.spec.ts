import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import type { AlertButton } from 'react-native';
import { createDeferred, renderScreen } from '@/dev/testkit';

import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { SttSink } from '@/voice/input/sttController';
import { createTurnEndpointController } from '@/voice/runtime/input/TurnEndpointController';
import { createNativeVoicePcmCaptureHarness } from '@/dev/testkit/harness/nativeVoicePcmCapture';
import type { VoiceAudioSessionApplyResult, VoiceAudioSessionCoordinator } from '@happier-dev/audio-stream-native';

const platformOsMock = vi.hoisted(() => ({ value: 'ios' }));
const nativeAlert = vi.hoisted(() => vi.fn<(title: string, message?: string, buttons?: AlertButton[]) => void>());
const openSettings = vi.hoisted(() => vi.fn(async () => {}));
const webVadState = vi.hoisted(() => ({
  onSpeechEnd: null as null | (() => void),
}));
const audioSessionRuntime = vi.hoisted(() => ({ coordinator: null as VoiceAudioSessionCoordinator | null }));
let audioSessionHarness: ReturnType<typeof createNativeVoicePcmCaptureHarness>;
let applyAudioSession: ReturnType<typeof createNativeVoicePcmCaptureHarness>['apply'];
let restoreAudioSession: ReturnType<typeof createNativeVoicePcmCaptureHarness>['restore'];

vi.mock('@happier-dev/audio-stream-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/audio-stream-native')>(),
  getSharedVoiceAudioSessionCoordinator: () => audioSessionRuntime.coordinator,
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Alert: { alert: nativeAlert },
    Linking: { openSettings },
    Platform: {
      get OS() {
        return platformOsMock.value;
      },
    },
  });
});

const requestRecordingPermissions = vi.fn(async () => ({ granted: true, canAskAgain: true }));
vi.mock('expo-audio', () => ({
  AudioModule: { requestRecordingPermissionsAsync: requestRecordingPermissions },
}));

const addListener = vi.fn((eventName: string, cb: (event: any) => void) => {
  listeners[eventName] = cb;
  return { remove: vi.fn() };
});
const start = vi.fn();
const stop = vi.fn();
const abortRecognition = vi.fn();
const requestPermissionsAsync = vi.fn(async () => ({ granted: true, canAskAgain: true }));
const isRecognitionAvailable = vi.fn(() => true);
const listeners: Record<string, (event: any) => void> = {};

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    addListener,
    start,
    stop,
    abort: abortRecognition,
    requestPermissionsAsync,
    isRecognitionAvailable,
  },
}));

vi.mock('@ricky0123/vad-web', () => ({
  MicVAD: {
    new: vi.fn(async (options: { onSpeechEnd?: () => void; getStream?: () => Promise<MediaStream> }) => {
      await options.getStream?.();
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

const { createNativeMicSession } = await import('@/voice/runtime/mic/NativeMicSession');
const { ModalProvider, useVisibleModalKind } = await import('@/modal');

function createMicSession(acquireStream?: () => Promise<MediaStream>): MicSession {
  const session = createNativeMicSession({
    // Browser/native stream acquisition is the boundary; the mic lifetime stays real.
    acquireStream: acquireStream ?? (async () => ({ getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream)),
  });
  vi.spyOn(session, 'ensureActive');
  vi.spyOn(session, 'teardown');
  return session;
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
    start.mockClear();
    stop.mockClear();
    abortRecognition.mockClear();
    for (const key of Object.keys(listeners)) delete listeners[key];
    audioSessionHarness = createNativeVoicePcmCaptureHarness(false);
    audioSessionRuntime.coordinator = audioSessionHarness.coordinator;
    applyAudioSession = audioSessionHarness.apply;
    restoreAudioSession = audioSessionHarness.restore;
    requestRecordingPermissions.mockReset();
    requestRecordingPermissions.mockResolvedValue({ granted: true, canAskAgain: true });
    nativeAlert.mockClear();
    openSettings.mockClear();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  });

  afterEach(async () => {
    // Reset only the OS restoration boundary after the case has observed its
    // failure/retained custody, so the real owner can dispose without retry timers.
    restoreAudioSession.mockReset();
    restoreAudioSession.mockResolvedValue(undefined);
    await audioSessionHarness.coordinator.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();

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

  it.each(['ios', 'web'])('keeps %s conversation recognition on the device default independently of Reply in', async (platformOs) => {
    platformOsMock.value = platformOs;
    const settings = { voice: { ...baseSettings(false).voice, assistantLanguage: 'es', dictation: { language: 'de' } } };
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => settings });
    await controller.start({ capturePurpose: 'conversation', micSession: createMicSession(), sink: createSink() });
    expect(start.mock.calls[0]?.[0]).not.toHaveProperty('lang');
    stop.mockImplementationOnce(() => listeners.end?.({}));
    await controller.stop();
  });

  it('uses the independent Dictation language at the device recognition boundary', async () => {
    const settings = { voice: { ...baseSettings(false).voice, assistantLanguage: 'es', dictation: { language: ' de ' } } };
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => settings });
    await controller.start({ capturePurpose: 'dictation', micSession: createMicSession(), sink: createSink() });
    expect(start.mock.calls[0]?.[0]).toMatchObject({ lang: 'de' });
    stop.mockImplementationOnce(() => listeners.end?.({}));
    await controller.stop();
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

  it('stops provider capture while muted and rearms it exactly once on unmute', async () => {
    const sink = createSink();
    const micSession = createMicSession();
    const onEndpointSignal = vi.fn();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true),
      onEndpointSignal,
    });

    await controller.start({ micSession, sink });
    expect(start).toHaveBeenCalledTimes(1);

    let muteSettled = false;
    const mute = controller.setMuted(true).then(() => {
      muteSettled = true;
    });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(muteSettled).toBe(false);

    listeners.result?.({ results: [{ transcript: 'muted partial' }], isFinal: false });
    listeners.result?.({ results: [{ transcript: 'muted final' }], isFinal: true });

    expect(sink.onPartial).not.toHaveBeenCalled();
    expect(sink.onFinal).not.toHaveBeenCalled();
    expect(sink.onAudioStarted).not.toHaveBeenCalled();
    expect(sink.onEndpoint).not.toHaveBeenCalled();
    expect(onEndpointSignal).not.toHaveBeenCalled();

    listeners.end?.({});
    await mute;

    await controller.setMuted(false);
    expect(start).toHaveBeenCalledTimes(2);

    await controller.setMuted(false);
    expect(start).toHaveBeenCalledTimes(2);

    listeners.result?.({ results: [{ transcript: 'heard after unmute' }], isFinal: true });
    expect(sink.onFinal).toHaveBeenCalledWith('heard after unmute');
  });

  it('rejects mute when provider capture does not confirm it stopped', async () => {
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
      stopTimeoutMs: 0,
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });

    await expect(controller.setMuted(true)).rejects.toThrow('device_stt_mute_timeout');
    expect(stop).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(abortRecognition).toHaveBeenCalledTimes(1);
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

  it.each(['interim result', 'speechstart'])(
    'cancels a stale heuristic deadline when an %s resumes speech',
    async (resumedEvent) => {
      vi.useFakeTimers();
      const onEndpointSignal = vi.fn();
      const { createDeviceSttController } = await import('./DeviceSttController');
      const controller = createDeviceSttController({
        getSettings: () => baseSettings(true, { silenceMs: 600, minSpeechMs: 0 }),
        onEndpointSignal,
      });
      await controller.start({ micSession: createMicSession(), sink: createSink() });
      listeners.result?.({ results: [{ transcript: 'hello runtime' }], isFinal: true });
      await vi.advanceTimersByTimeAsync(200);
      if (resumedEvent === 'speechstart') {
        listeners.speechstart?.({});
      } else {
        listeners.result?.({ results: [{ transcript: 'more words' }], isFinal: false });
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(onEndpointSignal).not.toHaveBeenCalled();

      listeners.result?.({ results: [{ transcript: 'more words' }], isFinal: true });
      await vi.advanceTimersByTimeAsync(599);
      expect(onEndpointSignal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onEndpointSignal).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        source: 'heuristic', transcript: 'hello runtime more words',
      }));
    },
  );

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
    const endpoint = createDeferred<void>();
    const onEndpointSignal = vi.fn(() => { endpoint.resolve(); });
    const onSpeechCandidateStart = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, { silenceMs: 30, minSpeechMs: 10 }),
      onEndpointSignal,
      onSpeechCandidateStart,
    });

    const micSession = createMicSession();
    await controller.start({
      capturePurpose: 'conversation',
      micSession,
      sink: createSink(),
    });
    listeners.speechstart?.({});
    listeners.result?.({ results: [{ transcript: 'native vad backed transcript' }], isFinal: true });

    expect(applyAudioSession).toHaveBeenCalledWith({
      generation: expect.any(Number),
      configuration: { mode: 'conversation', input: true, output: false, aec: 'off', capture: 'provider_managed_exclusive' },
    });
    expect(audioSessionHarness.coordinator.getSnapshot().leaseCount).toBe(1);
    expect(micSession.ensureActive).not.toHaveBeenCalled();
    expect(onSpeechCandidateStart).toHaveBeenCalledWith({
      sessionId: expect.any(String), source: 'device_recognizer',
    });
    await endpoint.promise;
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
        source: 'heuristic',
        transcript: 'native vad backed transcript',
    }));
  });

  it('uses the current hands-free endpointing defaults for the web-owned VAD stream', async () => {
    platformOsMock.value = 'web';
    (globalThis as { window?: object }).window = {};
    (globalThis as { document?: object }).document = {};
    const { createWebVadController } = await import('@/voice/runtime/input/WebVadController.web');
    const { MicVAD } = await import('@ricky0123/vad-web');
    const webVadController = createWebVadController({ onEndpointSignal: vi.fn() });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(true, null),
      webVadController,
      onEndpointSignal: vi.fn(),
    });

    await controller.start({ micSession: createMicSession(), sink: createSink() });

    expect(MicVAD.new).toHaveBeenCalledWith(expect.objectContaining({
      minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      redemptionMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
      getStream: expect.any(Function),
    }));
  });

  it('holds exactly one provider-exclusive lease and releases it once on explicit stop', async () => {
    const micSession = createMicSession();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });

    await controller.start({ micSession, sink: createSink() });

    expect(micSession.ensureActive).not.toHaveBeenCalled();
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalled();

    await controller.stop();
    await controller.stop();
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a second start instead of replacing the active exclusive lease', async () => {
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    await controller.start(params);
    await expect(controller.start(params)).rejects.toThrow('device_stt_already_started');
    expect(applyAudioSession).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
  });

  it('reserves native admission before awaiting the exclusive lease', async () => {
    start.mockClear();
    addListener.mockClear();
    const deferredLease = createDeferred<VoiceAudioSessionApplyResult>();
    const applying = createDeferred<void>();
    applyAudioSession.mockImplementationOnce(() => { applying.resolve(); return deferredLease.promise; });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    const firstStart = controller.start(params);
    await applying.promise;
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    const concurrentStart = controller.start(params);

    await expect(concurrentStart).rejects.toThrow('device_stt_already_started');
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    deferredLease.resolve({ generation: 1, aecAvailable: false, aecActive: false, route: 'test' });
    await firstStart;

    expect(start).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(6);
    await controller.stop();
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
  });

  it('cancels and clears a native start reservation when stop wins during lease acquisition', async () => {
    start.mockClear();
    addListener.mockClear();
    const deferredLease = createDeferred<VoiceAudioSessionApplyResult>();
    const applying = createDeferred<void>();
    applyAudioSession.mockImplementationOnce(() => { applying.resolve(); return deferredLease.promise; });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession: createMicSession(), sink: createSink() };

    const starting = controller.start(params);
    await applying.promise;
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    const stopping = controller.stop();
    deferredLease.resolve({ generation: 1, aecAvailable: false, aecActive: false, route: 'test' });

    await expect(starting).resolves.toBeUndefined();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    expect(start).not.toHaveBeenCalled();
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);

    await expect(controller.start(params)).resolves.toBeUndefined();
    expect(applyAudioSession).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(1);
    await controller.stop();
    expect(restoreAudioSession).toHaveBeenCalledTimes(2);
  });

  it('settles stop while native acquisition is pending and releases the late lease', async () => {
    start.mockClear();
    const deferredLease = createDeferred<VoiceAudioSessionApplyResult>();
    const applying = createDeferred<void>();
    const restoring = createDeferred<void>();
    applyAudioSession.mockImplementationOnce(() => { applying.resolve(); return deferredLease.promise; });
    restoreAudioSession.mockImplementationOnce(async () => { restoring.resolve(); });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    const starting = controller.start({ micSession: createMicSession(), sink: createSink() });
    await applying.promise;
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    const stopping = controller.stop();
    await expect(stopping).resolves.toEqual({ finalText: '' });
    await expect(starting).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();

    deferredLease.resolve({ generation: 1, aecAvailable: false, aecActive: false, route: 'test' });
    await restoring.promise;
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('reserves web admission before awaiting the shared browser mic', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    addListener.mockClear();
    const deferredMic = createDeferred<void>();
    const acquiring = createDeferred<void>();
    const micSession = createMicSession(async () => { acquiring.resolve(); await deferredMic.promise; return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream; });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false), stopTimeoutMs: 0 });
    const params = { micSession, sink: createSink() };

    const firstStart = controller.start(params);
    await acquiring.promise;
    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    const concurrentStart = controller.start(params);

    await expect(concurrentStart).rejects.toThrow('device_stt_already_started');
    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(applyAudioSession).not.toHaveBeenCalled();
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
    requestRecordingPermissions.mockClear();
    start.mockClear();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ sink: createSink() } as never)).rejects.toThrow('mic_session_required');
    expect(requestRecordingPermissions).not.toHaveBeenCalled();
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

  it.each(['web', 'ios'] as const)(
    'surfaces an unavailable %s recognizer before provider or microphone work',
    async (platformOs) => {
      platformOsMock.value = platformOs;
      isRecognitionAvailable.mockClear();
      isRecognitionAvailable.mockReturnValueOnce(false);
      requestRecordingPermissions.mockClear();
      requestPermissionsAsync.mockClear();
      applyAudioSession.mockClear();
      addListener.mockClear();
      start.mockClear();
      const micSession = createMicSession();
      const sink = createSink();
      const { createDeviceSttController } = await import('./DeviceSttController');
      const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

      await controller.start({ micSession, sink });

      expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'speech_recognition_unavailable',
        reason: 'device_stt_unavailable',
        presentation: 'error',
        recoverable: false,
        recoveryAction: 'select_speech_engine',
      }));
      expect(isRecognitionAvailable).toHaveBeenCalledTimes(1);
      expect(requestRecordingPermissions).not.toHaveBeenCalled();
      expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
      expect(requestPermissionsAsync).not.toHaveBeenCalled();
      expect(micSession.ensureActive).not.toHaveBeenCalled();
      expect(applyAudioSession).not.toHaveBeenCalled();
      expect(addListener).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      const reportedFailure = sink.onError.mock.calls[0]?.[0];
      const stopResult = await controller.stop();

      expect(stopResult).toEqual({ error: reportedFailure });
    },
  );

  it('presents the canonical recovery once when native speech recognition denies its secondary permission', async () => {
    requestRecordingPermissions.mockResolvedValueOnce({ granted: true, canAskAgain: true });
    requestPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ micSession: createMicSession(), sink: createSink() }))
      .rejects.toThrow('mic_permission_denied');
    expect(nativeAlert).toHaveBeenCalledTimes(1);
    const { t } = await import('@/text');
    expect(nativeAlert).toHaveBeenCalledWith(
      t('modals.microphoneAccessRequiredTitle'),
      t('modals.microphoneAccessRequiredEnableInSettings'),
      expect.arrayContaining([expect.objectContaining({ onPress: expect.any(Function) })]),
    );
    const settingsButton = nativeAlert.mock.calls[0]?.[2]?.find((button) => button.text === t('modals.openSettings'));
    expect(settingsButton?.onPress).toBeTypeOf('function');
    settingsButton!.onPress!();
    expect(openSettings).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);

    await expect(controller.start({ micSession: createMicSession(), sink })).resolves.toBeUndefined();
    await controller.stop();
    expect(applyAudioSession).toHaveBeenCalledTimes(2);
    expect(restoreAudioSession).toHaveBeenCalledTimes(2);
  });

  it('releases the exclusive native lease when recognizer listener setup fails', async () => {
    addListener.mockImplementationOnce(() => {
      throw new Error('listener_setup_failed');
    });
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await expect(controller.start({ micSession: createMicSession(), sink })).rejects.toThrow('listener_setup_failed');

    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('publishes a recognizer error only after its exclusive audio lease settles', async () => {
    const releaseSettled = createDeferred<void>();
    restoreAudioSession.mockImplementationOnce(() => releaseSettled.promise);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'network',
    }));
  });

  it('settles an unsolicited end once when exclusive audio-session release rejects', async () => {
    const releaseFailure = new Error('native_audio_session_release_failed');
    const releaseSettled = createDeferred<void>();
    const reported = createDeferred<void>();
    const publicationOrder: string[] = [];
    const unhandledRejections: unknown[] = [];
    let stopSettlementCount = 0;
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    restoreAudioSession.mockImplementation(() => {
      publicationOrder.push('release_attempted');
      return releaseSettled.promise;
    });
    const sink = createSink();
    sink.onError.mockImplementation(() => {
      publicationOrder.push('terminal_published');
      reported.resolve();
    });
    process.on('unhandledRejection', captureUnhandledRejection);

    try {
      const { createDeviceSttController } = await import('./DeviceSttController');
      const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });
      await controller.start({ micSession: createMicSession(), sink });

      listeners.end?.({});
      const stopping = controller.stop().finally(() => {
        stopSettlementCount += 1;
      });
      const stopExpectation = expect(stopping).resolves.toEqual({
        error: expect.objectContaining({
          kind: 'provider_error',
          reason: 'device_stt_error',
          recoverable: true,
          recoveryAction: 'retry',
        }),
      });
      await flushMicrotasks();
      expect(sink.onError).not.toHaveBeenCalled();

      releaseSettled.reject(releaseFailure);
      await stopExpectation;
      const terminalResult = await stopping;
      await reported.promise;
      expect(sink.onError).toHaveBeenCalledTimes(1);
      const terminalError = sink.onError.mock.calls[0]?.[0];
      listeners.end?.({});
      listeners.error?.({ error: 'network' });
      await flushMicrotasks();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(restoreAudioSession).toHaveBeenCalledTimes(1);
      expect(publicationOrder).toEqual(['release_attempted', 'terminal_published']);
      expect(stopSettlementCount).toBe(1);
      expect(terminalResult).toEqual({ error: terminalError });
      expect(terminalError).toMatchObject({
        kind: 'provider_error',
        reason: 'device_stt_error',
        recoverable: true,
        recoveryAction: 'retry',
      });
      expect(sink.onError).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', captureUnhandledRejection);
    }
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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

    const stoppingSecondCapture = controller.stop();
    secondEnd?.({});
    await stoppingSecondCapture;

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

  it('normalizes no-speech, speech-timeout, and no-match after an explicit stop to one empty terminal outcome', async () => {
    const { createDeviceSttController } = await import('./DeviceSttController');

    for (const outcome of ['no-speech', 'speech-timeout', 'nomatch'] as const) {
      const sink = createSink();
      const controller = createDeviceSttController({
        getSettings: () => baseSettings(false),
      });

      await controller.start({ micSession: createMicSession(), sink });
      const stopping = controller.stop();
      if (outcome === 'nomatch') {
        listeners.nomatch?.({});
        listeners.end?.({});
      } else {
        listeners.error?.({ error: outcome });
      }

      await expect(stopping).resolves.toEqual({ finalText: '' });
      expect(sink.onError).not.toHaveBeenCalled();
    }
  });

  it('surfaces a spontaneous no-speech termination instead of silently ending the active capture', async () => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.audiostart?.({});
    listeners.error?.({ error: 'no-speech' });
    listeners.end?.({});
    const terminalResult = await controller.stop();

    expect(sink.onError).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'no-speech',
    }));
    expect(terminalResult).toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'no-speech',
      }),
    });
  });

  it('surfaces a spontaneous end-only termination instead of publishing an empty success', async () => {
    const restoration = createDeferred<void>();
    const restoring = createDeferred<void>();
    restoreAudioSession.mockImplementationOnce(() => { restoring.resolve(); return restoration.promise; });
    const sink = createSink();
    const reported = createDeferred<void>();
    sink.onError.mockImplementationOnce(() => { reported.resolve(); });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      getSettings: () => baseSettings(false),
    });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.end?.({});
    const stopping = controller.stop();
    const terminalResult = await stopping;

    await restoring.promise;
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
    expect(sink.onError).not.toHaveBeenCalled();
    restoration.resolve();
    await reported.promise;
    expect(sink.onError).toHaveBeenCalledTimes(1);
    expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'provider_error',
      reason: 'device_stt_error',
    }));
    expect(terminalResult).toEqual({
      error: expect.objectContaining({
        kind: 'provider_error',
        reason: 'device_stt_error',
      }),
    });
  });

  it('fails a missing microphone as unavailable without the permission alert', async () => {
    platformOsMock.value = 'web';
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException('No input device', 'NotFoundError'); }) } });
    let visibleModalKind: ReturnType<typeof useVisibleModalKind> = null;
    function AlertStateProbe() {
      visibleModalKind = useVisibleModalKind();
      return null;
    }
    await renderScreen(React.createElement(ModalProvider, null, React.createElement(AlertStateProbe)));
    const { createDeviceSttController } = await import('./DeviceSttController');
    const { isMicrophoneUnavailableError } = await import('@/utils/platform/microphonePermissions');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    let failure: unknown;
    await act(async () => {
      failure = await controller.start({ micSession: createMicSession(), sink: createSink() }).then(() => null, (error: unknown) => error);
    });
    expect(isMicrophoneUnavailableError(failure)).toBe(true);
    expect(visibleModalKind).toBeNull();
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it.each([
    ['not-allowed', 'mic_permission_denied', 'permission_required', 'open_settings'],
    ['audio-capture', 'mic_unavailable', 'error', 'retry'],
    ['service-not-allowed', 'speech_recognition_unavailable', 'error', 'select_speech_engine'],
  ] as const)('surfaces a refused recognizer (%s) as an actionable failed attempt', async (reason, kind, presentation, recoveryAction) => {
    const sink = createSink();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession: createMicSession(), sink });
    listeners.error?.({ error: reason });

    await expect(controller.stop()).resolves.toEqual({ error: expect.objectContaining({ kind, reason }) });
    expect(sink.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind, reason, presentation, recoveryAction, recoverable: false }));
    const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
    const error = sink.onError.mock.calls[0]?.[0];
    expect(deriveLocalVoiceSessionSnapshot('local_direct', 'local', {
      adapterId: null, controlSessionId: 'refused-speech', state: 'error',
      reconnecting: false, micMuted: false, error,
    })).toMatchObject({ status: 'error', canStop: false, errorCode: kind, errorRecoveryAction: recoveryAction });
  });

  it.each(['available', 'missing'] as const)('distinguishes recognizer audio-capture from a %s web microphone', async (microphone) => {
    platformOsMock.value = 'web';
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(async () => {
      if (microphone === 'missing') throw new DOMException('No input device', 'NotFoundError');
      return { getTracks: () => [{ stop: stopTrack }] };
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const { createDeviceSttController } = await import('./DeviceSttController');
    const { classifyVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
    const micSession = createMicSession();
    const sink = createSink();
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    if (microphone === 'missing') {
      const failure = await controller.start({ micSession, sink }).then(() => null, (error: unknown) => error);
      expect(classifyVoiceMachineError(failure)).toMatchObject({
        kind: 'mic_unavailable', presentation: 'error', recoveryAction: 'retry',
      });
      expect(micSession.ensureActive).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } else {
      await controller.start({ micSession, sink });
      expect(stopTrack).toHaveBeenCalled();
      expect(micSession.ensureActive).toHaveBeenCalled();
      listeners.error?.({ error: 'audio-capture' });
      expect(await controller.stop()).toMatchObject({ error: {
        kind: 'speech_recognition_unavailable', reason: 'audio-capture',
        presentation: 'error', recoveryAction: 'select_speech_engine', recoverable: false,
      } });
      expect(sink.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'speech_recognition_unavailable' }));
    }
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
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
    const { createWebVadController } = await import('@/voice/runtime/input/WebVadController.web');
    const { MicVAD } = await import('@ricky0123/vad-web');
    const successfulVad = createWebVadController({ onEndpointSignal: vadBackedEndpoint });
    const failedVad = createWebVadController({ onEndpointSignal: fallbackEndpoint });
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

    vi.mocked(MicVAD.new).mockRejectedValueOnce(new Error('vad_sdk_unavailable'));
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
    const requestingPermission = createDeferred<void>();
    requestRecordingPermissions.mockImplementationOnce(() => {
      requestingPermission.resolve();
      return permission.promise;
    });
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
    await requestingPermission.promise;
    expect(requestRecordingPermissions).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(starting).resolves.toBeUndefined();
    await expect(controller.stop()).resolves.toMatchObject({
      error: { kind: 'turn_aborted', reason: 'turn_aborted' },
    });
    expect(applyAudioSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    permission.resolve({ granted: true, canAskAgain: true });
    await permission.promise;
    expect(applyAudioSession).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during native coordinator acquisition and releases a late lease', async () => {
    start.mockClear();
    const lease = createDeferred<VoiceAudioSessionApplyResult>();
    const applying = createDeferred<void>();
    const restoring = createDeferred<void>();
    applyAudioSession.mockImplementationOnce(() => { applying.resolve(); return lease.promise; });
    restoreAudioSession.mockImplementationOnce(async () => { restoring.resolve(); });
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
    await applying.promise;
    expect(applyAudioSession).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(starting).resolves.toBeUndefined();
    await expect(controller.stop()).resolves.toMatchObject({
      error: { kind: 'turn_aborted', reason: 'turn_aborted' },
    });
    expect(start).not.toHaveBeenCalled();

    lease.resolve({ generation: 1, aecAvailable: false, aecActive: false, route: 'test' });
    await restoring.promise;
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during browser mic acquisition without starting VAD or recognition', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    const micReady = createDeferred<void>();
    const acquiring = createDeferred<void>();
    const released = createDeferred<void>();
    const stopTrack = vi.fn(() => { released.resolve(); });
    const micSession = createMicSession(async () => {
      acquiring.resolve();
      await micReady.promise;
      // The physical browser track is the boundary; its lifecycle stays real.
      return { getTracks: () => [{ stop: stopTrack }], getAudioTracks: () => [] } as unknown as MediaStream;
    });
    const { createWebVadController } = await import('@/voice/runtime/input/WebVadController.web');
    const { MicVAD } = await import('@ricky0123/vad-web');
    vi.mocked(MicVAD.new).mockClear();
    const webVadController = createWebVadController({ onEndpointSignal: vi.fn() });
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
    await acquiring.promise;
    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(starting).resolves.toBeUndefined();
    await expect(controller.stop()).resolves.toMatchObject({
      error: { kind: 'turn_aborted', reason: 'turn_aborted' },
    });
    expect(MicVAD.new).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    // The caller owns the shared mic facade, including a late browser stream.
    await micSession.teardown();
    expect(stopTrack).not.toHaveBeenCalled();

    micReady.resolve();
    await released.promise;
    await micSession.teardown();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(MicVAD.new).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('settles an abort during web VAD startup without starting recognition', async () => {
    platformOsMock.value = 'web';
    start.mockClear();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    const { createWebVadController } = await import('@/voice/runtime/input/WebVadController.web');
    const { MicVAD } = await import('@ricky0123/vad-web');
    const vadReady = createDeferred<Awaited<ReturnType<typeof MicVAD.new>>>();
    const initializingVad = createDeferred<void>();
    vi.mocked(MicVAD.new).mockClear();
    vi.mocked(MicVAD.new).mockImplementationOnce(() => { initializingVad.resolve(); return vadReady.promise; });
    const webVadController = createWebVadController({ onEndpointSignal: vi.fn() });
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
    await initializingVad.promise;
    expect(MicVAD.new).toHaveBeenCalledTimes(1);
    abortController.abort();
    await expect(starting).resolves.toBeUndefined();
    await expect(controller.stop()).resolves.toMatchObject({
      error: { kind: 'turn_aborted', reason: 'turn_aborted' },
    });
    expect(start).not.toHaveBeenCalled();

    const paused = createDeferred<void>();
    const pauseVad = vi.fn(async () => { paused.resolve(); });
    // The browser SDK instance is the boundary; the host VAD lifecycle stays real.
    // Only start/pause of the third-party SDK instance are consumed in this boundary case.
    vadReady.resolve({ start: vi.fn(), pause: pauseVad } as unknown as Awaited<ReturnType<typeof MicVAD.new>>);
    await paused.promise;
    expect(pauseVad).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
  });

  it('does not start a recognizer when the abort signal fires during async setup', async () => {
    start.mockClear();
    const sink = createSink();
    const abortController = new AbortController();
    const micSession = createMicSession();
    const restoring = createDeferred<void>();
    restoreAudioSession.mockImplementationOnce(async () => { restoring.resolve(); });
    // Abort while the provider-exclusive lease is being acquired, before the recognizer starts.
    applyAudioSession.mockImplementationOnce(async () => {
      abortController.abort();
      return { generation: 1, aecAvailable: false, aecActive: false, route: 'test' };
    });

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({ getSettings: () => baseSettings(false) });

    await controller.start({ micSession, sink, signal: abortController.signal });

    expect(start).not.toHaveBeenCalled();
    await restoring.promise;
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);
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
    expect(restoreAudioSession).toHaveBeenCalledTimes(1);

    // A late abort after completion must not reach the torn-down recognizer.
    stop.mockClear();
    abortController.abort();
    expect(stop).not.toHaveBeenCalled();
  });
});
