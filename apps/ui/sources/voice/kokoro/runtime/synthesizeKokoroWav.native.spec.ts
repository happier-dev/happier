import { describe, expect, it, vi } from 'vitest';

import {
  prepareKokoroTts,
  prewarmKokoroRuntime,
  streamKokoroWavSentences,
  synthesizeKokoroWav,
} from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';

describe('synthesizeKokoroWav (native)', () => {
  it('rejects preparation of an unavailable built-in publication before install or network work', async () => {
    const ensureInstalled = vi.fn();
    const kokoroNativeModule = {
      initialize: vi.fn(),
      listVoices: vi.fn(),
      synthesizeToWavFile: vi.fn(),
      cancel: vi.fn(),
    };

    await expect(prepareKokoroTts(
      {
        assetSetId: 'kokoro-en-v0_19',
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        kokoroNativeModule,
        ensureInstalled,
        resolveManifestUrl: () => 'https://example.com/broken-manifest.json',
        fs: { File: class {}, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
      },
    )).rejects.toThrow('model_pack_publication_unavailable');

    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(kokoroNativeModule.initialize).not.toHaveBeenCalled();
  });

  it('rejects direct synthesis, streaming, and prewarm for an installed unavailable publication', async () => {
    const ensureInstalled = vi.fn(async () => ({
      packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-unavailable',
      manifest: {
        packId: 'kokoro-en-v0_19',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'installed-before-publication-was-disabled',
        files: [],
      } as any,
    }));
    const kokoroNativeModule = {
      initialize: vi.fn(async () => {
        throw new Error('unavailable_pack_reached_native_runtime');
      }),
      listVoices: vi.fn(),
      synthesizeToWavFile: vi.fn(),
      cancel: vi.fn(),
    };
    const opts = {
      text: 'hello',
      assetSetId: 'kokoro-en-v0_19',
      voiceId: 'af_bella',
      speed: 1,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    };
    const overrides = {
      kokoroNativeModule,
      ensureInstalled,
      resolveManifestUrl: () => 'https://example.com/previously-installed-manifest.json',
      fs: { File: class {}, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
    };

    await expect(synthesizeKokoroWav(opts, overrides))
      .rejects.toThrow('model_pack_publication_unavailable');
    await expect(streamKokoroWavSentences(opts, overrides)[Symbol.asyncIterator]().next())
      .rejects.toThrow('model_pack_publication_unavailable');
    await expect(prewarmKokoroRuntime(opts, overrides))
      .rejects.toThrow('model_pack_publication_unavailable');

    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(kokoroNativeModule.initialize).not.toHaveBeenCalled();
    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();
  });

  it('throws when the model pack is not installed', async () => {
    const fileDelete = vi.fn().mockResolvedValue(undefined);
    class Directory {
      uri: string;
      exists = false;
      constructor(..._uris: any[]) {
        this.uri = 'file:///docs/happier/voice/kokoro/kokoro-test';
      }
      create() {}
    }
    class File {
      uri: string;
      exists = false;
      constructor(...uris: any[]) {
        this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
      }
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      }
      async text() {
        return '';
      }
      create() {}
      delete = fileDelete;
      async bytes() {
        return new Uint8Array([1]);
      }
    }

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      synthesizeKokoroWav(
        {
          text: 'hello',
          assetSetId: 'kokoro-test',
          voiceId: 'af_bella',
          speed: 1,
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
        {
          kokoroNativeModule,
          fs: {
            File,
            Directory,
            Paths: { cache: 'file:///tmp/', document: 'file:///docs/' },
          } as any,
          resolveOutWavPath: () => 'file:///tmp/out.wav',
        },
      ),
    ).rejects.toThrow(/model_pack_not_installed/);

    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();
  });

  it('synthesizes via the native module and returns wav bytes', async () => {
    const fileDelete = vi.fn().mockRejectedValue(new Error('delete_failed'));
    class File {
      uri: string;
      constructor(...uris: any[]) {
        if (uris.length === 1 && typeof uris[0] === 'string') {
          this.uri = uris[0];
          return;
        }
        const [_base, name] = uris;
        this.uri = `file:///tmp/${String(name ?? '')}`;
      }
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      delete = fileDelete;
    }

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const bytes = await synthesizeKokoroWav(
      {
        text: 'hello',
        assetSetId: 'kokoro-test',
        voiceId: 'af_bella',
        speed: 1,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        kokoroNativeModule,
        fs: {
          File,
          Paths: { cache: 'file:///tmp/', document: 'file:///docs/' },
          deleteAsync: () => {
            throw new Error('deprecated_deleteAsync_called');
          },
        } as any,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled: async () => ({
          packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test',
          manifest: {
            packId: 'kokoro-test',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '1.0.0',
            voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
            files: [],
          } as any,
        }),
      },
    );

    expect(kokoroNativeModule.initialize).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 0 }),
    );
    expect(fileDelete).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('uses the exact published canonical Kokoro pack when assetSetId is missing', async () => {
    class File {
      uri: string;
      constructor(...uris: any[]) {
        this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
      }
      async arrayBuffer() {
        return new Uint8Array([1, 2, 3, 4]).buffer;
      }
      delete = vi.fn().mockResolvedValue(undefined);
    }
    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const ensureInstalled = vi.fn().mockResolvedValue({
      packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-82m-v1.0-onnx-q8-wasm',
      manifest: {
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'kokoro-int8-multi-lang-v1_1',
        files: [],
      } as any,
    });

    await synthesizeKokoroWav(
      {
        text: 'hello',
        assetSetId: null,
        voiceId: 'af_bella',
        speed: 1,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        kokoroNativeModule,
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled,
      },
    );

    expect(ensureInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        mode: 'require_installed',
      }),
      expect.anything(),
    );
    expect(kokoroNativeModule.initialize).toHaveBeenCalledOnce();
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledOnce();
  });

  it('preserves an explicit unknown experiment id for custom Kokoro development', async () => {
    class File {
      uri: string;
      constructor(...uris: any[]) {
        this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
      }
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      }
      delete = vi.fn().mockResolvedValue(undefined);
    }

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const ensureInstalled = vi.fn().mockResolvedValue({
      packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-82m-v1.0-onnx-fp32-wasm',
      manifest: {
        packId: 'kokoro-82m-v1.0-onnx-fp32-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '1.0.0',
        files: [],
      } as any,
    });
    const resolveManifestUrl = vi.fn(() => 'https://example.com/kokoro-82m-v1.0-onnx-fp32-wasm__manifest.json');

    await synthesizeKokoroWav(
      {
        text: 'hello',
        assetSetId: 'kokoro-82m-v1.0-onnx-fp32-wasm',
        voiceId: 'af_bella',
        speed: 1,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        kokoroNativeModule,
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled,
        resolveManifestUrl,
      },
    );

    expect(resolveManifestUrl).toHaveBeenCalledWith('kokoro-82m-v1.0-onnx-fp32-wasm');
    expect(ensureInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'kokoro-82m-v1.0-onnx-fp32-wasm' }),
      expect.anything(),
    );
  });

  it('cancels in-flight synthesis when aborted', async () => {
    const fileDelete = vi.fn().mockResolvedValue(undefined);
    class File {
      uri: string;
      constructor(...uris: any[]) {
        if (uris.length === 1 && typeof uris[0] === 'string') {
          this.uri = uris[0];
          return;
        }
        const [_base, name] = uris;
        this.uri = `file:///tmp/${String(name ?? '')}`;
      }
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      }
      delete = fileDelete;
    }

    let synthesizeResolve: ((v: { wavPath: string; sampleRate: number }) => void) | null = null;
    const synthesizePromise = new Promise<{ wavPath: string; sampleRate: number }>((resolve) => {
      synthesizeResolve = resolve;
    });

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockImplementation(() => synthesizePromise),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const controller = new AbortController();
    const promise = synthesizeKokoroWav(
      {
        text: 'hello',
        assetSetId: 'kokoro-test',
        voiceId: 'af_bella',
        speed: 1,
        timeoutMs: 5000,
        signal: controller.signal,
      },
      {
        kokoroNativeModule,
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled: async () => ({
          packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test',
          manifest: { packId: 'kokoro-test', kind: 'tts_sherpa', model: 'kokoro', version: '1.0.0', files: [] } as any,
        }),
      },
    );

    // Abort only once the native job is genuinely in flight: cancelling before
    // it starts would prove the pre-start bail, not in-flight cancellation.
    await vi.waitFor(() => expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1));
    controller.abort();

    expect(kokoroNativeModule.cancel).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.cancel).toHaveBeenCalledWith({
      jobId: kokoroNativeModule.synthesizeToWavFile.mock.calls[0]?.[0]?.jobId,
    });

    const settle: (v: { wavPath: string; sampleRate: number }) => void = synthesizeResolve ?? (() => {});
    settle({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 });

    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it('cancels the exact native job on deadline and waits for its settlement before cleanup', async () => {
    vi.useFakeTimers();
    try {
      const fileDelete = vi.fn().mockResolvedValue(undefined);
      class File {
        uri: string;
        constructor(...uris: any[]) {
          this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
        }
        async arrayBuffer() {
          return new Uint8Array([1]).buffer;
        }
        delete = fileDelete;
      }

      let rejectNativeSynthesis: (error: Error) => void = () => {};
      const nativeSynthesis = new Promise<{ wavPath: string; sampleRate: number }>((_resolve, reject) => {
        rejectNativeSynthesis = reject;
      });
      const kokoroNativeModule = {
        initialize: vi.fn().mockResolvedValue(undefined),
        listVoices: vi.fn().mockResolvedValue([]),
        synthesizeToWavFile: vi.fn().mockImplementation(() => nativeSynthesis),
        cancel: vi.fn().mockResolvedValue(undefined),
      };

      const promise = synthesizeKokoroWav(
        {
          text: 'hello',
          assetSetId: 'kokoro-timeout-cleanup-test',
          voiceId: 'af_bella',
          speed: 1,
          timeoutMs: 5,
          signal: new AbortController().signal,
        },
        {
          kokoroNativeModule,
          fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
          resolveOutWavPath: () => 'file:///tmp/out.wav',
          ensureInstalled: async () => ({
            packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-timeout-cleanup-test',
            manifest: {
              packId: 'kokoro-timeout-cleanup-test',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0',
              voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
              files: [],
            } as any,
          }),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      const jobId = kokoroNativeModule.synthesizeToWavFile.mock.calls[0]?.[0]?.jobId;
      expect(typeof jobId).toBe('string');

      await vi.advanceTimersByTimeAsync(5);

      expect(kokoroNativeModule.cancel).toHaveBeenCalledWith({ jobId });
      expect(fileDelete).not.toHaveBeenCalled();

      let settled = false;
      void promise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      rejectNativeSynthesis(new Error('native_cancelled'));

      await expect(promise).rejects.toThrow('timeout');
      expect(fileDelete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to built-in voiceId mapping when manifest has no voices', async () => {
    const fileDelete = vi.fn().mockResolvedValue(undefined);
    class File {
      uri: string;
      constructor(...uris: any[]) {
        if (uris.length === 1 && typeof uris[0] === 'string') {
          this.uri = uris[0];
          return;
        }
        const [_base, name] = uris;
        this.uri = `file:///tmp/${String(name ?? '')}`;
      }
      async arrayBuffer() {
        return new Uint8Array([9, 9]).buffer;
      }
      delete = fileDelete;
    }

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue(Array.from({ length: 11 }).map((_, i) => ({ id: `sid:${i}`, title: `Speaker ${i}`, sid: i }))),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await synthesizeKokoroWav(
      {
        text: 'hello',
        assetSetId: 'kokoro-test-v0',
        voiceId: 'af_bella',
        speed: 1,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      {
        kokoroNativeModule,
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled: async () => ({
          packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test-v0',
          manifest: { packId: 'kokoro-test-v0', kind: 'tts_sherpa', model: 'kokoro', version: '1.0.0', files: [] } as any,
        }),
      },
    );

    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 1 }),
    );
  });

  it('forwards model pack download progress (including file) during prepare', async () => {
    const onProgress = vi.fn();

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const ensureInstalled = vi.fn().mockImplementation(async (opts: any) => {
      opts?.onProgress?.({ loaded: 1, total: 4, file: 'onnx/model_quantized.onnx' });
      return {
        packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test',
        manifest: {
          packId: 'kokoro-test',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: '1.0.0',
          voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
          files: [],
        } as any,
      };
    });

    class File {
      uri: string;
      constructor(...uris: any[]) {
        this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
      }
    }

    await prepareKokoroTts(
      {
        assetSetId: 'kokoro-test',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onProgress,
      },
      {
        kokoroNativeModule,
        ensureInstalled,
        resolveManifestUrl: () => 'https://example.com/manifest.json',
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
      },
    );

    expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 4, file: 'onnx/model_quantized.onnx' });
  });

  it('does not poison the speaker-count cache when the first lookup fails (retry succeeds)', async () => {
    // L4-5: a transient listVoices failure must not be cached. A poisoned cache
    // would pin the failed `null` speaker count for the assets dir forever,
    // permanently degrading speaker-id resolution on every later synth.
    const fileDelete = vi.fn().mockResolvedValue(undefined);
    class File {
      uri: string;
      constructor(...uris: any[]) {
        this.uri = typeof uris[0] === 'string' ? uris[0] : 'file:///tmp/out.wav';
      }
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      }
      delete = fileDelete;
    }

    // First lookup rejects (transient); the retry resolves the real 11-speaker
    // (v0.19) catalog.
    const listVoices = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient_list_voices_failure'))
      .mockResolvedValueOnce(
        Array.from({ length: 11 }).map((_, i) => ({ id: `sid:${i}`, title: `Speaker ${i}`, sid: i })),
      );

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices,
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    // Unique assets dir so the module-level cache is not pre-populated by a
    // sibling test.
    const overrides = {
      kokoroNativeModule,
      fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
      resolveOutWavPath: () => 'file:///tmp/out.wav',
      ensureInstalled: async () => ({
        packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-cache-poison-test',
        manifest: {
          packId: 'kokoro-cache-poison-test',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: '1.0.0',
          files: [],
        } as any,
      }),
    };

    const baseOpts = {
      text: 'hello',
      assetSetId: 'kokoro-cache-poison-test',
      voiceId: 'af_bella',
      speed: 1,
      timeoutMs: 5000,
    };

    // First call: listVoices fails → speaker count unknown → fallback sid (v1.0
    // map → af_bella = 0). Synthesis still proceeds.
    await synthesizeKokoroWav({ ...baseOpts, signal: new AbortController().signal }, overrides);
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 0 }),
    );

    // Second call (same assets dir): listVoices now succeeds with 11 speakers.
    // A poisoned cache would reuse the failed `null` and keep sid 0; the fix
    // re-queries and resolves the v0.19 (11-speaker) sid = 1.
    await synthesizeKokoroWav({ ...baseOpts, signal: new AbortController().signal }, overrides);
    expect(listVoices).toHaveBeenCalledTimes(2);
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 1 }),
    );
  });
});
