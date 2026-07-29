import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  beforeEach(() => {
    playAudioBytesWithStopperSpy.mockClear();
    playAudioBytesWithStopperSpy.mockResolvedValue(undefined);
    streamKokoroWavSentencesSpy.mockClear();
  });

  it('registers a stopper that aborts in-flight synthesis', async () => {
    let registeredStopper: (() => void) | null = null;
    const registerPlaybackStopper = (stopper: () => void) => {
      registeredStopper = stopper;
      return () => {};
    };

    const onPlaybackStarted = vi.fn();
    const promise = speakKokoroText({
      text: 'hello',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper,
      onPlaybackStarted,
    });

    expect(typeof registeredStopper).toBe('function');
    registeredStopper!();

    await expect(promise).rejects.toThrow('aborted');
    expect(playAudioBytesWithStopperSpy).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });

  it('reports playback start once on the first actual segment and completes after final playback', async () => {
    const a = new Uint8Array([1]).buffer;
    const b = new Uint8Array([2]).buffer;
    let finishFinalPlayback = () => {};
    const finalPlayback = new Promise<void>((resolve) => {
      finishFinalPlayback = resolve;
    });
    playAudioBytesWithStopperSpy
      .mockImplementationOnce(async (opts: any) => {
        opts.onPlaybackStarted?.();
      })
      .mockImplementationOnce(async (opts: any) => {
        opts.onPlaybackStarted?.();
        await finalPlayback;
      });

    streamKokoroWavSentencesSpy.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        yield { wavBytes: a, sentenceText: 'a' };
        yield { wavBytes: b, sentenceText: 'b' };
      },
    }));

    const onPlaybackStarted = vi.fn();
    let completed = false;
    const speakingPromise = speakKokoroText({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    });
    void speakingPromise.then(() => {
      completed = true;
    });

    await vi.waitFor(() => {
      expect(playAudioBytesWithStopperSpy).toHaveBeenCalledTimes(2);
    });
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
    finishFinalPlayback();
    await speakingPromise;
    expect(playAudioBytesWithStopperSpy).toHaveBeenCalledTimes(2);
    expect(playAudioBytesWithStopperSpy.mock.calls[0]?.[0]?.bytes).toBe(a);
    expect(playAudioBytesWithStopperSpy.mock.calls[1]?.[0]?.bytes).toBe(b);
    expect(onPlaybackStarted).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
  });

  it('does not report playback start when synthesis fails before producing audio', async () => {
    streamKokoroWavSentencesSpy.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        throw new Error('kokoro_synthesis_failed');
      },
    }));
    const onPlaybackStarted = vi.fn();

    await expect(speakKokoroText({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
      onPlaybackStarted,
    })).rejects.toThrow('kokoro_synthesis_failed');

    expect(playAudioBytesWithStopperSpy).not.toHaveBeenCalled();
    expect(onPlaybackStarted).not.toHaveBeenCalled();
  });
});
