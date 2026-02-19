import { describe, expect, it, vi } from 'vitest';

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => true,
}));

const playAudioBytesWithStopperSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('@/voice/output/playAudioBytesWithStopper', () => ({
  playAudioBytesWithStopper: (opts: any) => playAudioBytesWithStopperSpy(opts),
}));

const streamKokoroWavSentencesSpy = vi.fn(
  ({ signal }: { signal: AbortSignal }) =>
    ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => reject(new Error('aborted'));
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    }) as AsyncIterable<{ wavBytes: ArrayBuffer; sentenceText: string }>,
);
const synthesizeKokoroWavSpy = vi.fn(async (_opts: any) => new Uint8Array([0]).buffer);
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  synthesizeKokoroWav: (opts: any) => synthesizeKokoroWavSpy(opts),
  streamKokoroWavSentences: (opts: any) => streamKokoroWavSentencesSpy(opts),
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

  it('plays sentence wavs sequentially', async () => {
    const a = new Uint8Array([1]).buffer;
    const b = new Uint8Array([2]).buffer;

    streamKokoroWavSentencesSpy.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { wavBytes: a, sentenceText: 'a' };
        yield { wavBytes: b, sentenceText: 'b' };
      },
    }));

    await speakKokoroText({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });

    expect(playAudioBytesWithStopperSpy).toHaveBeenCalledTimes(2);
    expect(playAudioBytesWithStopperSpy.mock.calls[0]?.[0]?.bytes).toBe(a);
    expect(playAudioBytesWithStopperSpy.mock.calls[1]?.[0]?.bytes).toBe(b);
  });
});
