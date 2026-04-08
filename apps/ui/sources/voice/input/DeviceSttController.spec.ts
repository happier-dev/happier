import { describe, expect, it, vi } from 'vitest';

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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createDeviceSttController', () => {
  it('trims the voice provider id before deciding whether hands-free device STT is enabled', async () => {
    const onAutoStopTurn = vi.fn();
    const patches: any[] = [];

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      setState: (patch) => patches.push(patch),
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
      canAutoStopTurn: () => true,
      onAutoStopTurn,
    });

    controller.setHandsFreeSession('session-1');
    await controller.start('session-1');
    expect(patches[patches.length - 1]).toEqual({ status: 'recording', sessionId: 'session-1', error: null });
    expect(start).toHaveBeenCalled();

    listeners.result?.({ results: [{ transcript: ' hello world ' }], isFinal: true });
    await flushMicrotasks();

    expect(onAutoStopTurn).toHaveBeenCalledWith('session-1');
  });

  it('normalizes the session id before tracking hands-free auto-stop', async () => {
    const onAutoStopTurn = vi.fn();
    const patches: any[] = [];

    const { createDeviceSttController } = await import('./DeviceSttController');
    const controller = createDeviceSttController({
      setState: (patch) => patches.push(patch),
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
      canAutoStopTurn: () => true,
      onAutoStopTurn,
    });

    controller.setHandsFreeSession(' session-2 ');
    await controller.start(' session-2 ');

    listeners.result?.({ results: [{ transcript: ' hello world ' }], isFinal: true });
    await flushMicrotasks();

    expect(patches[patches.length - 1]).toEqual({ status: 'recording', sessionId: 'session-2', error: null });
    expect(onAutoStopTurn).toHaveBeenCalledWith('session-2');
  });
});
