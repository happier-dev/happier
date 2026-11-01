import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RecognitionEvent = {
  isFinal?: boolean;
  results?: Array<{ transcript: string }>;
};

const { listeners, recognitionStop } = vi.hoisted(() => {
  const listeners = new Map<string, (event: RecognitionEvent) => void>();
  return {
    listeners,
    recognitionStop: vi.fn(() => listeners.get('end')?.({})),
  };
});

vi.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    start: vi.fn(),
    stop: recognitionStop,
    addListener: (event: string, listener: (event: RecognitionEvent) => void) => {
      listeners.set(event, listener);
      return { remove: () => listeners.delete(event) };
    },
  },
}));

vi.mock('@/utils/platform/microphonePermissions', () => ({
  requestMicrophonePermission: async () => ({ granted: true, canAskAgain: true }),
  showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

import { createDeviceSttController } from './DeviceSttController';

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  recognitionStop.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DeviceSttController hands-free endpointing', () => {
  it.each(['interim result', 'speechstart'])(
    'cancels the first silence deadline on a resumed %s and waits after the later final result',
    async (resumedEvent) => {
      const onAutoStopTurn = vi.fn();
      const controller = createDeviceSttController({
        getSettings: () => ({
          voice: {
            providerId: 'local_direct',
            adapters: {
              local_direct: {
                stt: { provider: 'device' },
                handsFree: { enabled: true, endpointing: { silenceMs: 450, minSpeechMs: 0 } },
              },
            },
          },
        }),
        setState: vi.fn(),
        canAutoStopTurn: () => true,
        onAutoStopTurn,
      });
      controller.setHandsFreeSession('s1');
      await controller.start('s1');

      listeners.get('result')?.({ isFinal: true, results: [{ transcript: 'hello' }] });
      await vi.advanceTimersByTimeAsync(200);
      if (resumedEvent === 'speechstart') {
        listeners.get('speechstart')?.({});
      } else {
        listeners.get('result')?.({ isFinal: false, results: [{ transcript: 'hello again' }] });
      }
      await vi.advanceTimersByTimeAsync(300);
      expect(onAutoStopTurn).not.toHaveBeenCalled();

      listeners.get('result')?.({ isFinal: true, results: [{ transcript: 'hello again' }] });
      await vi.advanceTimersByTimeAsync(449);
      expect(onAutoStopTurn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onAutoStopTurn).toHaveBeenCalledExactlyOnceWith('s1');
      await expect(controller.stop('s1')).resolves.toBe('hello again');
    },
  );
});
