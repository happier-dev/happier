import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/sync/domains/settings/voiceSettings';
import type { MicSession } from '@/voice/runtime/mic/MicSession';

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

  it('demotes web speech recognition to fallback turn-capture mode', async () => {
    platformOsMock.value = 'web';
    start.mockClear();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: false,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
    });

    await controller.start('session-web', createMicSession());

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      continuous: false,
    }));
  });

  it('trims the voice provider id before resolving endpoint signals', async () => {
    const onEndpointSignal = vi.fn();
    const onCaptureStarted = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted,
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: ' local_direct ',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: true,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
            local_conversation: {
              stt: { provider: 'openai_compat', useDeviceStt: false },
              handsFree: { enabled: false, endpointing: { silenceMs: 0, minSpeechMs: 0 } },
            },
          },
        },
      }),
      onEndpointSignal,
    });

    await controller.start('session-1', createMicSession());
    expect(onCaptureStarted).toHaveBeenCalledWith('session-1');
    expect(start).toHaveBeenCalled();

    listeners.result?.({ results: [{ transcript: ' hello world ' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      source: 'heuristic',
      transcript: 'hello world',
    }));
  });

  it('emits runtime-owned endpoint signals for finalized device transcripts', async () => {
    const onEndpointSignal = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: false,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
      onEndpointSignal,
    });

    await controller.start('session-endpoint', createMicSession());
    listeners.result?.({ results: [{ transcript: ' hello runtime ' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-endpoint',
      source: 'heuristic',
      transcript: 'hello runtime',
    }));
  });

  it('prefers web VAD endpoint signals over finalized transcript heuristics on web', async () => {
    platformOsMock.value = 'web';
    (globalThis as { window?: object }).window = {};
    (globalThis as { document?: object }).document = {};
    const onEndpointSignal = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: true,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
      onEndpointSignal,
    });

    await controller.start('session-vad', createMicSession());
    listeners.result?.({ results: [{ transcript: 'vad backed transcript' }], isFinal: true });
    await flushMicrotasks();

    expect(onEndpointSignal).not.toHaveBeenCalled();

    const onSpeechEnd = webVadState.onSpeechEnd as null | (() => void);
    onSpeechEnd?.();

    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-vad',
      source: 'web_vad',
      transcript: '',
    }));
  });

  it('prefers native VAD over finalized transcript heuristics when the native bridge starts', async () => {
    const onEndpointSignal = vi.fn();
    const nativeVadController = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => true),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: true,
                endpointing: { silenceMs: 30, minSpeechMs: 10 },
              },
            },
          },
        },
      }),
      nativeVadController,
      onEndpointSignal,
    });

    await controller.start('session-native-vad', createMicSession());
    listeners.result?.({ results: [{ transcript: 'native vad backed transcript' }], isFinal: true });
    await flushMicrotasks();

    expect(nativeVadController.startSession).toHaveBeenCalledWith({
      sessionId: 'session-native-vad',
      minSpeechMs: 10,
      redemptionMs: 30,
    });
    expect(onEndpointSignal).not.toHaveBeenCalled();
  });

  it('uses the current hands-free endpointing defaults when endpointing settings are missing', async () => {
    const onEndpointSignal = vi.fn();
    const nativeVadController = {
      isActiveSession: vi.fn(() => true),
      startSession: vi.fn(async () => false),
      stopSession: vi.fn(async () => {}),
    };

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: true,
                // Intentionally omit `endpointing` to assert the controller uses the
                // current schema defaults rather than legacy hardcoded values.
              },
            },
          },
        },
      }),
      nativeVadController,
      onEndpointSignal,
    });

    await controller.start('session-default-endpointing', createMicSession());

    expect(nativeVadController.startSession).toHaveBeenCalledWith({
      sessionId: 'session-default-endpointing',
      minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
      redemptionMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
    });
  });

  it('ensures an injected mic session is active before starting device STT', async () => {
    const micSession = createMicSession();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: false,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
    });

    await controller.start('session-mic', micSession);

    expect(micSession.ensureActive).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalled();
  });

  it('requires a mic session before starting device STT capture', async () => {
    requestMicrophonePermission.mockClear();
    start.mockClear();
    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: false,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
    });

    // @ts-expect-error intentional contract violation to verify the runtime guard
    await expect(controller.start('session-missing-mic')).rejects.toThrow('mic_session_required');
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
      onCaptureStarted: vi.fn(),
      onCaptureError: vi.fn(),
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: true,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
      nativeVadController,
      onEndpointSignal,
    });

    await controller.start('session-native-fallback', createMicSession());
    listeners.result?.({ results: [{ transcript: 'native fallback transcript' }], isFinal: true });
    await flushMicrotasks();

    expect(nativeVadController.startSession).toHaveBeenCalledWith({
      sessionId: 'session-native-fallback',
      minSpeechMs: 0,
      redemptionMs: 0,
    });
    expect(onEndpointSignal).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-native-fallback',
      source: 'heuristic',
      transcript: 'native fallback transcript',
    }));
  });

  it('surfaces device STT startup failures through the explicit capture-error callback', async () => {
    start.mockImplementationOnce(() => {
      throw new Error('speech_start_failed');
    });
    const onCaptureError = vi.fn();

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      onCaptureStarted: vi.fn(),
      onCaptureError,
      getSettings: () => ({
        voice: {
          providerId: 'local_direct',
          assistantLanguage: 'en',
          adapters: {
            local_direct: {
              stt: { provider: 'device', useDeviceStt: true },
              handsFree: {
                enabled: false,
                endpointing: { silenceMs: 0, minSpeechMs: 0 },
              },
            },
          },
        },
      }),
    });

    await expect(controller.start('session-error', createMicSession())).rejects.toThrow('speech_start_failed');
    expect(onCaptureError).toHaveBeenCalledWith({
      controlSessionId: 'session-error',
      reason: 'device_stt_start_failed',
    });
  });
});
