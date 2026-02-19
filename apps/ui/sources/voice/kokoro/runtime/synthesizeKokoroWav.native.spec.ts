import { describe, expect, it, vi } from 'vitest';

import { synthesizeKokoroWav } from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';
import { prepareKokoroTts } from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';

describe('synthesizeKokoroWav (native)', () => {
  it('throws when the model pack is not installed', async () => {
    const deleteAsync = vi.fn().mockResolvedValue(undefined);
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
      delete() {}
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
            deleteAsync,
          } as any,
          resolveOutWavPath: () => 'file:///tmp/out.wav',
        },
      ),
    ).rejects.toThrow(/model_pack_not_installed/);

    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();
  });

  it('synthesizes via the native module and returns wav bytes', async () => {
    const deleteAsync = vi.fn().mockResolvedValue(undefined);
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' }, deleteAsync },
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
    expect(deleteAsync).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('uses the default Kokoro asset set id when assetSetId is missing', async () => {
    const deleteAsync = vi.fn().mockResolvedValue(undefined);
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
    }

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const ensureInstalled = vi.fn().mockResolvedValue({
      packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test',
      manifest: {
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '1.0.0',
        voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' }, deleteAsync },
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled,
      },
    );

    expect(ensureInstalled).toHaveBeenCalledWith(expect.objectContaining({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }), expect.anything());
  });

  it('cancels in-flight synthesis when aborted', async () => {
    const deleteAsync = vi.fn().mockResolvedValue(undefined);
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' }, deleteAsync },
        resolveOutWavPath: () => 'file:///tmp/out.wav',
        ensureInstalled: async () => ({
          packDirUri: 'file:///docs/happier/voice/modelPacks/kokoro-test',
          manifest: { packId: 'kokoro-test', kind: 'tts_sherpa', model: 'kokoro', version: '1.0.0', files: [] } as any,
        }),
      },
    );

    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(kokoroNativeModule.cancel).toHaveBeenCalledTimes(1);

    // Prevent unhandled rejections in the test process.
    const settle: (v: { wavPath: string; sampleRate: number }) => void = synthesizeResolve ?? (() => {});
    settle({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 });
  });

  it('falls back to built-in voiceId mapping when manifest has no voices', async () => {
    const deleteAsync = vi.fn().mockResolvedValue(undefined);
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' }, deleteAsync },
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' }, deleteAsync: vi.fn() } as any,
      },
    );

    expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 4, file: 'onnx/model_quantized.onnx' });
  });
});
