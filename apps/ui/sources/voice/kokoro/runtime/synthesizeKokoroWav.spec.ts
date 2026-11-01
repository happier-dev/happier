import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('synthesizeKokoroWav (web)', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).Worker = undefined;
    (globalThis as any).window = { location: { href: 'http://example.test/' } };
  });

  it('does not rely on import.meta so Expo web bundles can parse it', () => {
    const source = fs.readFileSync(new URL('./kokoroWebWorkerClient.web.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('import.meta');
  });

  it('closes the TextSplitterStream so streaming requests complete', () => {
    const workerSource = fs.readFileSync(new URL('../../../../public/vendor/kokoro/kokoroTtsWorker.js', import.meta.url), 'utf8');
    expect(workerSource).toContain('splitter.close');
  });

  it('supports kokoro-js stream chunk audio shapes', () => {
    const workerSource = fs.readFileSync(new URL('../../../../public/vendor/kokoro/kokoroTtsWorker.js', import.meta.url), 'utf8');
    expect(workerSource).toContain('audioObj?.audio');
    expect(workerSource).toContain('audioObj?.sampling_rate');
  });

  it('uses an origin-relative worker URL so it works from nested routes', async () => {
    const created: any[] = [];
    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      constructor(...args: any[]) {
        created.push(args);
      }
      postMessage(_message: any) {}
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect(
      synthesizeKokoroWav({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/timeout/i);

    const url = String(created[0]?.[0] ?? '');
    expect(url).toBe('http://example.test/vendor/kokoro/kokoroTtsWorker.js');
  });

  it('does not time out while the worker is reporting progress', async () => {
    vi.useFakeTimers();
    try {
      class FakeWorker {
        onmessage: ((event: any) => void) | null = null;
        constructor(_url: any, _opts?: any) {}
        postMessage(message: any) {
          if (message?.type !== 'prepare') return;
          const id = message.id;
          setTimeout(() => this.onmessage?.({ data: { id, type: 'progress', progress: { loaded: 1, total: 10 } } }), 40);
          setTimeout(() => this.onmessage?.({ data: { id, type: 'progress', progress: { loaded: 6, total: 10 } } }), 80);
          setTimeout(() => this.onmessage?.({ data: { id, type: 'result', wavBytes: new ArrayBuffer(0) } }), 120);
        }
        terminate() {}
      }

      (globalThis as any).Worker = FakeWorker;
      const { prepareKokoroTts } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

      const promise = prepareKokoroTts({
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        timeoutMs: 50,
        signal: new AbortController().signal,
        onProgress: () => {},
      });

      // Advance in smaller increments so the progress callbacks can re-arm the timeout
      // before we cross the initial timeout boundary.
      await vi.advanceTimersByTimeAsync(45);
      await vi.advanceTimersByTimeAsync(45);
      await vi.advanceTimersByTimeAsync(45);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a web worker when available', async () => {
    const wavBytes = new Uint8Array([1, 2, 3, 4]).buffer;

    const workerMessages: any[] = [];
    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      onerror: ((event: any) => void) | null = null;
      constructor(_url: any, _opts?: any) {}
      postMessage(message: any) {
        workerMessages.push(message);
        if (message?.type === 'generate') {
          this.onmessage?.({ data: { id: message.id, type: 'result', wavBytes } });
        }
      }
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    const out = await synthesizeKokoroWav({
      text: 'hello',
      assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });

    expect(out).toBe(wavBytes);
    expect(workerMessages.some((m) => m?.type === 'generate')).toBe(true);
  });

  it('reuses a single worker instance across calls', async () => {
    const wavBytes = new Uint8Array([9, 9, 9]).buffer;
    const created: any[] = [];

    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      constructor(...args: any[]) {
        created.push(args);
      }
      postMessage(message: any) {
        if (message?.type === 'generate') {
          this.onmessage?.({ data: { id: message.id, type: 'result', wavBytes } });
        }
      }
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    const controller = new AbortController();
    await synthesizeKokoroWav({
      text: 'hello',
      assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await synthesizeKokoroWav({
      text: 'world',
      assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(created.length).toBe(1);
  });

  it('surfaces worker errors', async () => {
    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      constructor(_url: any, _opts?: any) {}
      postMessage(message: any) {
        if (message?.type === 'generate') {
          this.onmessage?.({ data: { id: message.id, type: 'error', message: 'boom' } });
        }
      }
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect(
      synthesizeKokoroWav({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/boom/);
  });

  it('aborts an in-flight request', async () => {
    let messageId: string | null = null;

    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      constructor(_url: any, _opts?: any) {}
      postMessage(message: any) {
        if (message?.type === 'generate') {
          messageId = message.id;
          return;
        }
        if (message?.type === 'cancel') {
          if (messageId && message.id === messageId) {
            // Worker canceled; no response will be delivered.
          }
        }
      }
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    const controller = new AbortController();
    const promise = synthesizeKokoroWav({
      text: 'hello',
      assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });

  it('times out when the worker does not respond', async () => {
    class FakeWorker {
      constructor(_url: any, _opts?: any) {}
      postMessage(_message: any) {}
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    await expect(
      synthesizeKokoroWav({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/timeout/i);
  });

  it('surfaces worker errors for streaming requests instead of waiting for the timeout', async () => {
    class FakeWorker {
      onmessage: ((event: any) => void) | null = null;
      constructor(_url: any, _opts?: any) {}
      postMessage(message: any) {
        if (message?.type === 'stream') {
          setTimeout(() => this.onmessage?.({ data: { id: message.id, type: 'error', message: 'boom' } }), 0);
        }
      }
      terminate() {}
    }

    (globalThis as any).Worker = FakeWorker;
    const { streamKokoroWavSentences } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

    const consume = async () => {
      for await (const _chunk of streamKokoroWavSentences({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        timeoutMs: 200,
        signal: new AbortController().signal,
      })) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow(/boom/);
  });

  it('keeps a streaming request alive while the worker reports model download progress', async () => {
    vi.useFakeTimers();
    try {
      class FakeWorker {
        onmessage: ((event: any) => void) | null = null;
        constructor(_url: any, _opts?: any) {}
        postMessage(message: any) {
          if (message?.type !== 'stream') return;
          const id = message.id;
          setTimeout(() => this.onmessage?.({ data: { id, type: 'progress', progress: { loaded: 1, total: 10 } } }), 40);
          setTimeout(() => this.onmessage?.({ data: { id, type: 'progress', progress: { loaded: 6, total: 10 } } }), 80);
          setTimeout(() => this.onmessage?.({ data: { id, type: 'stream_chunk', wavBytes: new ArrayBuffer(1), sentenceText: 'hello' } }), 120);
          setTimeout(() => this.onmessage?.({ data: { id, type: 'stream_end' } }), 121);
        }
        terminate() {}
      }

      (globalThis as any).Worker = FakeWorker;
      const { streamKokoroWavSentences } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

      const received: string[] = [];
      const consume = (async () => {
        for await (const chunk of streamKokoroWavSentences({
          text: 'hello',
          assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
          voiceId: 'af_heart',
          speed: 1,
          timeoutMs: 50,
          signal: new AbortController().signal,
        })) {
          received.push(chunk.sentenceText);
        }
      })();

      await vi.advanceTimersByTimeAsync(45);
      await vi.advanceTimersByTimeAsync(45);
      await vi.advanceTimersByTimeAsync(45);
      await expect(consume).resolves.toBeUndefined();
      expect(received).toEqual(['hello']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the kokoro-js default voice when the stored voice is not in the web catalog', async () => {
    const generate = vi.fn(async () => ({ audio: new Float32Array([0]), sampling_rate: 24000 }));
    vi.doMock('@/voice/kokoro/runtime/loadKokoroWebRuntime.web', () => ({
      loadKokoroWebRuntime: async () => ({
        KokoroTTS: {
          from_pretrained: async () => ({ voices: { af_heart: {}, af_bella: {} }, generate }),
        },
        env: {},
      }),
    }));
    (globalThis as any).caches = { open: async () => ({}) };
    try {
      const { synthesizeKokoroWav } = await import('@/voice/kokoro/runtime/synthesizeKokoroWav');

      // A native pack voice synced from a phone.
      await synthesizeKokoroWav({
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_maple',
        speed: 1,
        timeoutMs: 10_000,
        signal: new AbortController().signal,
      });

      expect(generate).toHaveBeenCalledWith('hello', expect.objectContaining({ voice: 'af_heart' }));
    } finally {
      vi.doUnmock('@/voice/kokoro/runtime/loadKokoroWebRuntime.web');
      delete (globalThis as any).caches;
    }
  });
});
