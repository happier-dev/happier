import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebAudioBoundary } from '@/dev/testkit/harness/webAudio';
import { createKokoroWorkerBoundary } from '@/dev/testkit/harness/kokoroWorker';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

let audio: ReturnType<typeof createWebAudioBoundary>;
let worker: ReturnType<typeof createKokoroWorkerBoundary>;

beforeEach(() => {
  vi.resetModules();
  worker = createKokoroWorkerBoundary();
  audio = createWebAudioBoundary();
  vi.stubGlobal('AudioContext', audio.AudioContext);
  vi.stubGlobal('Worker', worker.Worker);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function readStream() {
  await vi.waitFor(() => expect(worker.messages[0]?.type).toBe('stream'));
  return { worker, id: worker.messages[0]!.id };
}

describe('speakKokoroText', () => {
  it('treats a deliberate stop as completion, not as a failure', async () => {
    const { speakKokoroText } = await import('./KokoroTtsController');
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

    const stream = await readStream();
    expect(typeof registeredStopper).toBe('function');
    registeredStopper!();

    await expect(promise).resolves.toBeUndefined();
    expect(stream.worker.messages).toContainEqual({ id: stream.id, type: 'cancel' });
    expect(audio.sources).toHaveLength(0);
  });

  it('plays sentence wavs sequentially', async () => {
    const { speakKokoroText } = await import('./KokoroTtsController');
    audio.holdPlayback();
    const a = new Uint8Array([1]).buffer;
    const b = new Uint8Array([2]).buffer;
    let completed = false;
    const speaking = speakKokoroText({
      text: 'hello world',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });
    void speaking.then(() => { completed = true; });
    const { worker, id } = await readStream();
    worker.emit({ id, type: 'stream_chunk', wavBytes: a, sentenceText: 'a' });
    worker.emit({ id, type: 'stream_chunk', wavBytes: b, sentenceText: 'b' });
    worker.emit({ id, type: 'stream_end' });

    await vi.waitFor(() => expect(audio.sources[0]?.started).toBe(true));
    expect(audio.decodedBytes).toEqual([a]);
    expect(completed).toBe(false);
    audio.sources[0]!.finish();
    await vi.waitFor(() => expect(audio.sources[1]?.started).toBe(true));
    expect(audio.decodedBytes).toEqual([a, b]);
    expect(audio.sources[0]!.disconnected).toBe(true);
    expect(completed).toBe(false);
    audio.sources[1]!.finish();
    await speaking;
    expect(completed).toBe(true);
  });

  it('rejects when synthesis fails without being stopped', async () => {
    const { speakKokoroText } = await import('./KokoroTtsController');
    const speaking = speakKokoroText({
      text: 'hello',
      voiceId: null,
      speed: 1,
      timeoutMs: 15000,
      registerPlaybackStopper: () => () => {},
    });
    const rejected = expect(speaking).rejects.toThrow('model_pack_not_installed');
    const { worker, id } = await readStream();
    worker.emit({ id, type: 'error', message: 'model_pack_not_installed' });
    await rejected;
    expect(audio.sources).toHaveLength(0);
  });
});
