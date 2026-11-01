import { describe, expect, it, vi } from 'vitest';

import { synthesizeKokoroWav } from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';
import { prepareKokoroTts, streamKokoroWavSentences } from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';

// Mirrors the published kokoro-int8-multi-lang-v1_1 pack: explicit sids, defaultVoiceId af_maple, no af_heart.
const PUBLISHED_PACK_MANIFEST = {
  packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
  kind: 'tts_sherpa',
  model: 'kokoro',
  version: 'kokoro-int8-multi-lang-v1_1',
  defaultVoiceId: 'af_maple',
  voices: [
    { id: 'af_maple', title: 'Maple', sid: 0 },
    { id: 'af_sol', title: 'Sol', sid: 1 },
    { id: 'bf_vale', title: 'Vale', sid: 2 },
  ],
  files: [],
} as any;

function createNativeHarness(manifest: any = PUBLISHED_PACK_MANIFEST) {
  class File {
    uri: string;
    constructor(...uris: any[]) {
      this.uri = uris.length === 1 && typeof uris[0] === 'string' ? uris[0] : `file:///tmp/${String(uris[1] ?? '')}`;
    }
    async arrayBuffer() {
      return new Uint8Array([7]).buffer;
    }
    async delete() {}
  }
  const kokoroNativeModule = {
    initialize: vi.fn().mockResolvedValue(undefined),
    // 103 speakers would make the legacy static map pick a wrong (Mandarin) speaker for af_heart.
    listVoices: vi.fn().mockResolvedValue(Array.from({ length: 103 }).map((_, i) => ({ id: `sid:${i}`, title: `${i}`, sid: i }))),
    synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const ensureInstalled = vi.fn().mockResolvedValue({ packDirUri: 'file:///docs/pack', manifest });
  return {
    kokoroNativeModule,
    ensureInstalled,
    overrides: {
      kokoroNativeModule,
      ensureInstalled,
      fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
      resolveOutWavPath: () => 'file:///tmp/out.wav',
    },
  };
}

describe('Kokoro native voice resolution', () => {
  it.each([
    ['unset', null],
    ['a web-only voice', 'af_heart'],
  ])('uses the installed pack default voice when the stored voice is %s', async (_label, voiceId) => {
    const harness = createNativeHarness();

    await synthesizeKokoroWav(
      { text: 'hello', assetSetId: null, voiceId, speed: 1, timeoutMs: 5000, signal: new AbortController().signal },
      harness.overrides,
    );

    expect(harness.kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_maple', sid: 0 }),
    );
  });

  it('falls back to the first catalog voice when the installed manifest predates defaultVoiceId', async () => {
    const { defaultVoiceId: _omit, ...legacyStored } = PUBLISHED_PACK_MANIFEST;
    const harness = createNativeHarness({ ...legacyStored, voices: [{ id: 'bf_vale', title: 'Vale', sid: 2 }, ...legacyStored.voices] });

    await synthesizeKokoroWav(
      { text: 'hello', assetSetId: null, voiceId: 'af_heart', speed: 1, timeoutMs: 5000, signal: new AbortController().signal },
      harness.overrides,
    );

    expect(harness.kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'bf_vale', sid: 2 }),
    );
  });

  it('keeps a stored voice that exists in the installed pack', async () => {
    const harness = createNativeHarness();

    await synthesizeKokoroWav(
      { text: 'hello', assetSetId: null, voiceId: 'af_sol', speed: 1, timeoutMs: 5000, signal: new AbortController().signal },
      harness.overrides,
    );

    expect(harness.kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_sol', sid: 1 }),
    );
  });
});

describe('streamKokoroWavSentences (native)', () => {
  it('cancels the native job when a sentence times out so the native queue is freed', async () => {
    const harness = createNativeHarness();
    harness.kokoroNativeModule.synthesizeToWavFile.mockImplementation(() => new Promise(() => {}));

    const iterator = streamKokoroWavSentences(
      { text: 'Never finishes.', voiceId: null, speed: 1, timeoutMs: 20, signal: new AbortController().signal },
      harness.overrides,
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/timeout/);
    expect(harness.kokoroNativeModule.cancel).toHaveBeenCalledTimes(1);
  });

  it('synthesizes and yields one sentence at a time so playback can start early', async () => {
    const harness = createNativeHarness();
    let releaseSecond: (() => void) | null = null;
    harness.kokoroNativeModule.synthesizeToWavFile
      .mockResolvedValueOnce({ wavPath: 'file:///tmp/one.wav', sampleRate: 24000 })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = () => resolve({ wavPath: 'file:///tmp/two.wav', sampleRate: 24000 });
          }),
      );

    const iterator = streamKokoroWavSentences(
      { text: 'First sentence. Second sentence.', voiceId: null, speed: 1, timeoutMs: 5000, signal: new AbortController().signal },
      harness.overrides,
    )[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.sentenceText).toBe('First sentence.');
    expect(harness.kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1);

    const secondPromise = iterator.next();
    await vi.waitFor(() => expect(releaseSecond).toBeTruthy());
    releaseSecond!();
    const second = await secondPromise;
    expect(second.value?.sentenceText).toBe('Second sentence.');
    expect((await iterator.next()).done).toBe(true);
    expect(harness.ensureInstalled).toHaveBeenCalledTimes(1);
  });

  it('stops synthesizing remaining sentences once aborted', async () => {
    const harness = createNativeHarness();
    const controller = new AbortController();
    const iterator = streamKokoroWavSentences(
      { text: 'One. Two. Three.', voiceId: null, speed: 1, timeoutMs: 5000, signal: controller.signal },
      harness.overrides,
    )[Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toThrow(/aborted/);
    expect(harness.kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1);
  });
});

describe('synthesizeKokoroWav (native)', () => {
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
        fs: { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any,
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

  it.each([
    ['missing', null],
    // Settings sync across devices; web can select asset sets that have no published native pack.
    ['web-only', 'kokoro-82m-v1.0-onnx-fp32-wasm'],
  ])('uses the default Kokoro native pack when assetSetId is %s', async (_label, assetSetId) => {
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
        assetSetId,
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

    expect(ensureInstalled).toHaveBeenCalledWith(expect.objectContaining({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' }), expect.anything());
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

    await vi.waitFor(() => expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalled());
    controller.abort();

    await expect(promise).rejects.toThrow(/aborted/i);
    expect(kokoroNativeModule.cancel).toHaveBeenCalledTimes(1);

    // Prevent unhandled rejections in the test process.
    const settle: (v: { wavPath: string; sampleRate: number }) => void = synthesizeResolve ?? (() => {});
    settle({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 });
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

  it('forwards model pack download progress (including file counts) during prepare', async () => {
    const onProgress = vi.fn();

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const ensureInstalled = vi.fn().mockImplementation(async (opts: any) => {
      opts?.onProgress?.({ loaded: 1, total: 4, filesDone: 2, filesTotal: 7 });
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

    expect(onProgress).toHaveBeenCalledWith({ loaded: 1, total: 4, filesDone: 2, filesTotal: 7 });
  });
});
