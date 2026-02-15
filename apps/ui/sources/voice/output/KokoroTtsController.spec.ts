import { describe, expect, it, vi } from 'vitest';

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => true,
}));

const playAudioBytesWithStopperSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (opts: any) => playAudioBytesWithStopperSpy(opts),
}));

const synthesizeKokoroWavSpy = vi.fn(
  async ({ signal }: { signal: AbortSignal }) =>
    await new Promise<ArrayBuffer>((_resolve, reject) => {
      const onAbort = () => reject(new Error('aborted'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }),
);
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  synthesizeKokoroWav: (opts: any) => synthesizeKokoroWavSpy(opts),
}));

import { speakKokoroText } from '@/voice/output/KokoroTtsController';

describe('speakKokoroText', () => {
  it('registers a stopper that aborts in-flight synthesis', async () => {
    let registeredStopper: (() => void) | null = null;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {};
    };

    const promise = speakKokoroText({
      text: 'hello',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper,
    });

    expect(typeof registeredStopper).toBe('function');
    registeredStopper!();

    await expect(promise).rejects.toThrow('aborted');
    expect(playAudioBytesWithStopperSpy).not.toHaveBeenCalled();
  });
});
