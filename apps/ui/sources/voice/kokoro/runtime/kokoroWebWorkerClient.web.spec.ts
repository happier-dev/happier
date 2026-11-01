import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Kokoro worker stream lifecycle', () => {
  let completeSynthesis: boolean;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    completeSynthesis = true;
    // The Worker transport is the boundary; the real client owns timers and queued chunks.
    class CompletedWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      postMessage(message: { id: string; type: string }) {
        if (message.type !== 'stream' || !completeSynthesis) return;
        for (const sentenceText of ['First.', 'Second.']) {
          this.onmessage?.(new MessageEvent('message', {
            data: { id: message.id, type: 'stream_chunk', sentenceText, wavBytes: new ArrayBuffer(1) },
          }));
        }
        this.onmessage?.(new MessageEvent('message', { data: { id: message.id, type: 'stream_end' } }));
      }
    }
    vi.stubGlobal('Worker', CompletedWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function startStream(signal = new AbortController().signal) {
    const { streamKokoroWavSentencesInWorker } = await import('./kokoroWebWorkerClient.web');
    return streamKokoroWavSentencesInWorker({
      cfg: { modelId: 'model', dtype: 'q8', device: 'wasm', wasmPaths: '/' },
      text: 'First. Second.',
      voiceId: null,
      speed: 1,
      timeoutMs: 50,
      signal,
    })[Symbol.asyncIterator]();
  }

  it('drains completed synthesis after playback takes longer than the synthesis timeout', async () => {
    const iterator = await startStream();
    expect((await iterator.next()).value?.sentenceText).toBe('First.');

    await vi.advanceTimersByTimeAsync(51);

    await expect(iterator.next()).resolves.toMatchObject({ value: { sentenceText: 'Second.' }, done: false });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('still drops queued audio when stopped after synthesis completes', async () => {
    const controller = new AbortController();
    const iterator = await startStream(controller.signal);
    await iterator.next();

    controller.abort();

    await expect(iterator.next()).rejects.toThrow('aborted');
  });

  it('still times out synthesis that never responds', async () => {
    completeSynthesis = false;
    const iterator = await startStream();
    const pending = expect(iterator.next()).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(51);

    await pending;
  });
});
