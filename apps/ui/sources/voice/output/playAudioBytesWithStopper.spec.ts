import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

const createAudioPlayerSpy = vi.fn();
vi.mock('expo-audio', () => ({
  createAudioPlayer: (...args: any[]) => createAudioPlayerSpy(...args),
}));

import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';

describe('playAudioBytesWithStopper (web)', () => {
  it('registers a stopper and resolves when playback finishes', async () => {
    const remove = vi.fn();
    const play = vi.fn();
    let playbackStatusCb: ((status: any) => void) | null = null;

    createAudioPlayerSpy.mockReturnValue({
      addListener: (_event: string, cb: (status: any) => void) => {
        playbackStatusCb = cb;
        return { remove: vi.fn() };
      },
      remove,
      play,
    });

    const createObjectURL = vi.fn(() => 'blob:mock');
    const revokeObjectURL = vi.fn();
    (globalThis as any).URL = { createObjectURL, revokeObjectURL };

    let registeredStopper: (() => void) | null = null;
    let cleared = false;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {
        cleared = true;
      };
    };

    const promise = playAudioBytesWithStopper({
      bytes: new ArrayBuffer(4),
      format: 'wav',
      registerPlaybackStopper,
    });

    expect(typeof registeredStopper).toBe('function');
    expect(play).toHaveBeenCalledTimes(1);

    expect(typeof playbackStatusCb).toBe('function');
    playbackStatusCb!({ didJustFinish: true });

    await promise;

    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock');
    expect(cleared).toBe(true);
  });
});
