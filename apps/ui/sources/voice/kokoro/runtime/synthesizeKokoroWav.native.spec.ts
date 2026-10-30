import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createHash } from 'node:crypto';
import type { ModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';

import {
  prepareKokoroTts,
  prewarmKokoroRuntime,
  streamKokoroWavSentences,
  synthesizeKokoroWav,
} from '@/voice/kokoro/runtime/synthesizeKokoroWav.native';
import { createMemFs, createMemNativeDownload } from '@/voice/modelPacks/installerTestFs';
import { ensureModelPackInstalled } from '@/voice/modelPacks/installer.native';
import { filePathToUri } from '@/platform/fileUri';

const nativeArtifactDownload = vi.hoisted(() => vi.fn());
vi.mock('expo-file-system/legacy', () => ({
  createDownloadResumable: nativeArtifactDownload,
  FileSystemSessionType: { BACKGROUND: 0, FOREGROUND: 1 },
}));

const loadedNativeVoices = Array.from({ length: 3 }, (_, sid) => ({ id: `sid:${sid}`, title: `Speaker ${sid}`, sid }));

type NativeFs = NonNullable<NonNullable<Parameters<typeof synthesizeKokoroWav>[1]>['fs']>;

// Reuse the Expo filesystem boundary and the real installer to produce the pack
// metadata consumed by synthesis. Only WAV reads/deletes use the per-case OS double.
async function createInstalledKokoroFs(manifestInput: Omit<ModelPackManifest, 'files'>, wavFs: NativeFs) {
  const { fs: memoryFs } = createMemFs();
  class File extends memoryFs.File {
    async arrayBuffer() {
      return this.uri.startsWith('file:///tmp/') ? new wavFs.File(this.uri).arrayBuffer()
        : Uint8Array.from(await this.bytes()).buffer;
    }
    delete() {
      return this.uri.startsWith('file:///tmp/') ? new wavFs.File(this.uri).delete() : super.delete();
    }
  }
  const fs = { ...memoryFs, File, Paths: { ...memoryFs.Paths, cache: 'file:///tmp/' } };
  const bytes = new Uint8Array([1]);
  const manifest = { ...manifestInput, files: ['model.onnx', ...(manifestInput.frontend?.lexicon ? [manifestInput.frontend.lexicon] : [])]
    .map(path => ({ path, url: `https://example.com/${path}`, sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })) };
  const fetchImpl: typeof fetch = async input => new URL(String(input)).pathname.endsWith('manifest.json')
    ? Response.json(manifest) : new Response(bytes);
  const install = ensureModelPackInstalled({ packId: manifest.packId, mode: 'download_if_missing',
    manifestUrl: 'https://example.com/manifest.json', timeoutMs: null, signal: new AbortController().signal },
    { fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl) });
  // The real Expo host yields between bounded disk chunks. Complete fixture
  // installation before starting the native operation's controlled clock.
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await install;
  return fs;
}

async function createNativeSentenceFixture(text: string, controller = new AbortController(), onSynthesis?: (sentence: string) => void) {
  const wavs = new Map<string, ArrayBuffer>();
  class File {
    constructor(readonly uri: string) {}
    async arrayBuffer() {
      const bytes = wavs.get(this.uri);
      if (!bytes) throw new Error('native_wav_missing');
      return bytes;
    }
    delete() { wavs.delete(this.uri); }
  }
  const fs = await createInstalledKokoroFs({ packId: 'kokoro-sentence-stream', kind: 'tts_sherpa',
      model: 'kokoro', version: 'v1', voices: [{ id: 'af_bella', title: 'Bella', sid: 2 }] }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } });
  const synthesizeToWavFile = vi.fn(async ({ text: sentence, outWavPath }: { text: string; outWavPath: string | null }) => {
    if (!outWavPath) throw new Error('native_wav_path_missing');
    onSynthesis?.(sentence);
    wavs.set(filePathToUri(outWavPath), new TextEncoder().encode(sentence).buffer);
    return { wavPath: outWavPath, sampleRate: 24_000 };
  });
  const native = { initialize: vi.fn(async () => {}), listVoices: vi.fn(async () => loadedNativeVoices),
    synthesizeToWavFile, cancel: vi.fn(async () => {}) };
  const stream = streamKokoroWavSentences({ text, assetSetId: 'kokoro-sentence-stream',
    voiceId: 'af_bella', speed: 1, timeoutMs: 5000, signal: controller.signal },
    { kokoroNativeModule: native, fs, resolveOutWavPath: jobId => `file:///tmp/${jobId}.wav` });
  return { stream, native, wavs };
}

describe('synthesizeKokoroWav (native)', () => {
  it('preserves verification and file progress through native Kokoro preparation', async () => {
    const { fs: memoryFs } = createMemFs();
    class File extends memoryFs.File {
      override open() {
        const handle = super.open();
        return { ...handle, readBytes: (length: number) => handle.readBytes(Math.min(length, 2)) };
      }
    }
    const fs = { ...memoryFs, File, Paths: { ...memoryFs.Paths, cache: 'file:///tmp/' } };
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const packId = 'kokoro-verification-progress';
    const manifest: ModelPackManifest = {
      packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v1',
      files: [{ path: 'model.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }],
    };
    const fetchImpl: typeof fetch = async input => new URL(String(input)).pathname.endsWith('manifest.json')
      ? Response.json(manifest) : new Response(bytes);
    const progress: unknown[] = [];
    await prepareKokoroTts({ assetSetId: packId, timeoutMs: null, signal: new AbortController().signal,
      onProgress: event => progress.push(event) }, {
      fs,
      resolveManifestUrl: () => 'https://example.com/manifest.json',
      // Bind only the filesystem/network boundaries; preparation, installation,
      // shared-core verification and progress forwarding remain the real path.
      ensureInstalled: (options, overrides) => ensureModelPackInstalled(options,
        { ...overrides, fs, fetch: fetchImpl, download: createMemNativeDownload(fs, fetchImpl) }),
      kokoroNativeModule: { initialize: async () => {}, listVoices: async () => [],
        synthesizeToWavFile: async () => ({ wavPath: 'file:///unused.wav', sampleRate: 24_000 }), cancel: async () => {} },
    });
    expect(progress).toContainEqual(expect.objectContaining({
      loaded: bytes.length, total: bytes.length, verified: 2, filesDone: 0, filesTotal: 1,
    }));
    expect(progress.at(-1)).toMatchObject({ verified: bytes.length, filesDone: 1, filesTotal: 1 });
  });

  it('streams one native WAV per sentence, in order, through the installed runtime', async () => {
    const { stream, native, wavs } = await createNativeSentenceFixture('Alpha. Beta. Gamma.');
    const out: string[] = [];
    for await (const chunk of stream) {
      out.push(chunk.sentenceText);
      expect(chunk.wavBytes).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(chunk.wavBytes)).toBe(chunk.sentenceText);
    }
    expect(out).toEqual(['Alpha.', 'Beta.', 'Gamma.']);
    expect(native.synthesizeToWavFile).toHaveBeenCalledTimes(3);
    expect(native.initialize).toHaveBeenCalledOnce();
    expect(wavs.size).toBe(0);
  });

  it('prefetches native synthesis of the next sentence while the current WAV is consumed', async () => {
    const synthOrder: string[] = [];
    const secondSynthesis = createDeferred<void>();
    const consumeOrder: string[] = [];
    const { stream } = await createNativeSentenceFixture('One. Two. Three.', undefined, sentence => {
      synthOrder.push(sentence);
      if (sentence === 'Two.') secondSynthesis.resolve();
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) throw new Error('first_sentence_missing');
    consumeOrder.push(first.value.sentenceText);
    await secondSynthesis.promise;
    expect(synthOrder).toContain('Two.');
    const second = await iterator.next();
    if (second.done) throw new Error('second_sentence_missing');
    consumeOrder.push(second.value.sentenceText);
    const third = await iterator.next();
    if (third.done) throw new Error('third_sentence_missing');
    consumeOrder.push(third.value.sentenceText);
    expect((await iterator.next()).done).toBe(true);
    expect(consumeOrder).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('rejects sentence streaming on cancellation without synthesizing the remaining sentences', async () => {
    const controller = new AbortController();
    const { stream, native } = await createNativeSentenceFixture(
      'First sentence here. Second sentence here. Third one here. Fourth one here.', controller,
      sentence => { if (sentence.startsWith('Second')) controller.abort(); });
    const seen: string[] = [];
    await expect((async () => { for await (const chunk of stream) seen.push(chunk.sentenceText); })()).rejects.toThrow(/aborted/i);
    expect(native.synthesizeToWavFile.mock.calls.length).toBeLessThan(4);
    expect(seen).not.toContain('Second sentence here.');
  });
  it('keeps unbounded native preparation pending until caller cancellation has retired its initialization', async () => {
    vi.useFakeTimers();
    try {
      const packId = 'kokoro-unbounded-preparation';
      const fs = await createInstalledKokoroFs({
        packId, kind: 'tts_sherpa', model: 'kokoro', version: 'v1', frontend: { lang: 'en' },
      }, { File: class {}, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } });
      let finishInitialization: (() => void) | undefined;
      let finishCancellation: (() => void) | undefined;
      const cancelInitialization = vi.fn(() => new Promise<void>((resolve) => { finishCancellation = resolve; }));
      const native = {
        initialize: () => new Promise<void>((resolve) => { finishInitialization = resolve; }),
        cancelInitialization,
        listVoices: async () => [],
        synthesizeToWavFile: async () => ({ wavPath: 'file:///unused.wav', sampleRate: 24_000 }),
        cancel: async () => {},
      };
      const caller = new AbortController();
      const preparation = prepareKokoroTts({ assetSetId: packId, signal: caller.signal,
        timeoutMs: null,
      }, { kokoroNativeModule: native, fs: { ...fs, Paths: { ...fs.Paths, cache: 'file:///tmp/' } } });
      const outcome = preparation.then(() => 'prepared', (error: unknown) => error instanceof Error ? error.message : String(error));
      let settled = false;
      void outcome.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(settled ? await outcome : 'pending').toBe('pending');
      expect(cancelInitialization).not.toHaveBeenCalled();
      caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelInitialization).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      finishCancellation?.();
      expect(await outcome).toBe('aborted');
      finishInitialization?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['bad', null])('rejects a manifest SID outside the loaded model instead of synthesizing speaker zero (%s)', async (voiceId) => {
    class File {
      uri: string;
      constructor(uri: string) { this.uri = uri; }
      async arrayBuffer() { return new Uint8Array([1]).buffer; }
      delete() {}
    }
    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue([{ id: 'sid:0', title: 'Speaker 0', sid: 0 }]),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    await expect(synthesizeKokoroWav({
      text: 'hello', assetSetId: 'kokoro-bounded-test', voiceId, speed: 1,
      timeoutMs: 5000, signal: new AbortController().signal,
    }, {
      kokoroNativeModule,
      fs: await createInstalledKokoroFs({ packId: 'kokoro-bounded-test',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: 'v1.1',
          voices: [{ id: 'bad', title: 'Bad metadata', sid: 1 }],
          defaultVoiceId: 'bad' }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } }),
      resolveOutWavPath: () => 'file:///tmp/out.wav',
    })).rejects.toThrow('kokoro_voice_unavailable');
    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();
  });

  it('rejects preparation of an unavailable built-in publication before install or network work', async () => {
    const { fs, files } = createMemFs();
    const readPack = vi.spyOn(fs.File.prototype, 'text');
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
        fs: { ...fs, Paths: { ...fs.Paths, cache: 'file:///tmp/' } },
      },
    )).rejects.toThrow('model_pack_publication_unavailable');

    expect(readPack).not.toHaveBeenCalled();
    expect(nativeArtifactDownload).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
    expect(kokoroNativeModule.initialize).not.toHaveBeenCalled();
  });

  it('rejects direct synthesis, streaming, and prewarm for an installed unavailable publication', async () => {
    const fs = await createInstalledKokoroFs({
        packId: 'kokoro-en-v0_19',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'installed-before-publication-was-disabled',
    }, { File: class {
        }, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } });
    const readPack = vi.spyOn(fs.File.prototype, 'text');
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
      fs,
    };

    await expect(synthesizeKokoroWav(opts, overrides))
      .rejects.toThrow('model_pack_publication_unavailable');
    await expect(streamKokoroWavSentences(opts, overrides)[Symbol.asyncIterator]().next())
      .rejects.toThrow('model_pack_publication_unavailable');
    await expect(prewarmKokoroRuntime(opts, overrides))
      .rejects.toThrow('model_pack_publication_unavailable');

    expect(readPack).not.toHaveBeenCalled();
    expect(nativeArtifactDownload).not.toHaveBeenCalled();
    expect(kokoroNativeModule.initialize).not.toHaveBeenCalled();
    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();
  });

  it('throws when the model pack is not installed', async () => {
    const { fs } = createMemFs();

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
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
          fs: { ...fs, Paths: { ...fs.Paths, cache: 'file:///tmp/' } },
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
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
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
        fs: await createInstalledKokoroFs({ packId: 'kokoro-test',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '1.0.0',
            frontend: { lang: 'en-us', lexicon: 'lexicon.txt' },
            voices: [{ id: 'af_bella', title: 'Bella', sid: 2 }] }, {
            File,
            Paths: { cache: 'file:///tmp/', document: 'file:///docs/' },
            deleteAsync: () => {
                throw new Error('deprecated_deleteAsync_called');
            },
        } as any),
        resolveOutWavPath: () => 'file:///tmp/out.wav',
      },
    );

    expect(kokoroNativeModule.initialize).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.initialize).toHaveBeenCalledWith(expect.objectContaining({
      frontend: { lang: 'en-us', lexicon: 'lexicon.txt' },
    }));
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 2, frontend: { lang: 'en-us', lexicon: 'lexicon.txt' } }),
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
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const fs = await createInstalledKokoroFs({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: 'kokoro-int8-multi-lang-v1_1',
        voices: [{ id: 'af_bella', title: 'Bella', sid: 2 }],
    }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } });

    const bytes = await synthesizeKokoroWav(
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
        fs,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
      },
    );

    expect(kokoroNativeModule.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        assetsDir: '/docs/happier/voice/modelPacks/kokoro-82m-v1.0-onnx-q8-wasm',
      }),
    );
    expect(kokoroNativeModule.initialize).toHaveBeenCalledOnce();
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledOnce();
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
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
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const fs = await createInstalledKokoroFs({
        packId: 'kokoro-82m-v1.0-onnx-fp32-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '1.0.0',
        voices: [{ id: 'af_bella', title: 'Bella', sid: 2 }],
    }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } });

    const bytes = await synthesizeKokoroWav(
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
        fs,
        resolveOutWavPath: () => 'file:///tmp/out.wav',
      },
    );

    expect(kokoroNativeModule.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ assetsDir: '/docs/happier/voice/modelPacks/kokoro-82m-v1.0-onnx-fp32-wasm' }),
    );
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1]));
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

    const synthesisStarted = createDeferred<void>();
    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
      synthesizeToWavFile: vi.fn().mockImplementation(() => { synthesisStarted.resolve(); return synthesizePromise; }),
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
        fs: await createInstalledKokoroFs({ packId: 'kokoro-test',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '1.0.0',
            voices: [{ id: 'af_bella', title: 'Bella', sid: 2 }] }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        resolveOutWavPath: () => 'file:///tmp/out.wav',
      },
    );

    // Abort only once the native job is genuinely in flight: cancelling before
    // it starts would prove the pre-start bail, not in-flight cancellation.
    await synthesisStarted.promise;
    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledTimes(1);
    controller.abort();

    expect(kokoroNativeModule.cancel).toHaveBeenCalledTimes(1);
    expect(kokoroNativeModule.cancel).toHaveBeenCalledWith({
      jobId: kokoroNativeModule.synthesizeToWavFile.mock.calls[0]?.[0]?.jobId,
    });

    const settle: (v: { wavPath: string; sampleRate: number }) => void = synthesizeResolve ?? (() => {});
    settle({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 });

    await expect(promise).rejects.toThrow(/aborted/i);
  });

  it('cleans the initialization cancellation listener and deadline after native initialization succeeds', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      const kokoroNativeModule = {
        initialize: vi.fn().mockResolvedValue(undefined),
        listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
        synthesizeToWavFile: vi.fn(),
        cancel: vi.fn().mockResolvedValue(undefined),
      };

      await prepareKokoroTts(
        {
          assetSetId: 'kokoro-init-cleanup-success',
          timeoutMs: 50,
          signal: controller.signal,
        },
        {
          kokoroNativeModule,
          fs: await createInstalledKokoroFs({ packId: 'kokoro-init-cleanup-success',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0' }, { File: class {
              }, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        },
      );

      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only the queued native initialization admission when abort overtakes it, leaving active same-pack work alone', async () => {
    vi.useFakeTimers();
    try {
      let resolveInitialization: () => void = () => {};
      const initialization = new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      });
      const cancelledAdmissions = new Set<string>();
      const publishedAdmissions: string[] = [];
      let activeJobCancelled = false;
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      const kokoroNativeModule = {
        initialize: vi.fn(async ({ initializationId }: { initializationId: string }) => {
          await initialization;
          if (!cancelledAdmissions.has(initializationId)) publishedAdmissions.push(initializationId);
        }),
        listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
        synthesizeToWavFile: vi.fn(),
        cancel: vi.fn().mockResolvedValue(undefined),
        cancelInitialization: vi.fn(async ({ initializationId }: { initializationId: string }) => {
          cancelledAdmissions.add(initializationId);
        }),
        releaseAssetsDir: vi.fn(async () => {
          activeJobCancelled = true;
          return { cancelledJobs: 0, releasedEngines: 0 };
        }),
      };

      const preparation = prepareKokoroTts(
        {
          assetSetId: 'kokoro-init-abort-race',
          timeoutMs: 50,
          signal: controller.signal,
        },
        {
          kokoroNativeModule,
          fs: await createInstalledKokoroFs({ packId: 'kokoro-init-abort-race',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0' }, { File: class {
              }, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(kokoroNativeModule.initialize).toHaveBeenCalledOnce();

      controller.abort();

      await expect(preparation).rejects.toThrow('aborted');
      expect(kokoroNativeModule.cancelInitialization).toHaveBeenCalledWith({
        assetsDir: '/docs/happier/voice/modelPacks/kokoro-init-abort-race',
        initializationId: expect.any(String),
      });
      expect(kokoroNativeModule.releaseAssetsDir).not.toHaveBeenCalled();
      expect(activeJobCancelled).toBe(false);
      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);

      resolveInitialization();
      await Promise.resolve();
      await Promise.resolve();
      expect(publishedAdmissions).toEqual([]);

      // A new immutable admission has not been cancelled, so it can still warm
      // the same active pack after the stale queued initialization is refused.
      await prepareKokoroTts(
        {
          assetSetId: 'kokoro-init-abort-race',
          timeoutMs: 50,
          signal: new AbortController().signal,
        },
        {
          kokoroNativeModule,
          fs: await createInstalledKokoroFs({ packId: 'kokoro-init-abort-race',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0' }, { File: class {
              }, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        },
      );
      expect(publishedAdmissions).toEqual([expect.any(String)]);
      expect(publishedAdmissions[0]).not.toBe(cancelledAdmissions.values().next().value);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the initialization listener and deadline before a slow admission cancellation settles', async () => {
    vi.useFakeTimers();
    try {
      let resolveInitialization: () => void = () => {};
      const initialization = new Promise<void>((resolve) => {
        resolveInitialization = resolve;
      });
      let resolveCancellation: () => void = () => {};
      const admissionCancellation = new Promise<void>((resolve) => {
        resolveCancellation = resolve;
      });
      const controller = new AbortController();
      const removeAbortListener = vi.spyOn(controller.signal, 'removeEventListener');
      const kokoroNativeModule = {
        initialize: vi.fn(() => initialization),
        listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
        synthesizeToWavFile: vi.fn(),
        cancel: vi.fn().mockResolvedValue(undefined),
        cancelInitialization: vi.fn(async () => await admissionCancellation),
        releaseAssetsDir: vi.fn(),
      };

      const preparation = prepareKokoroTts(
        {
          assetSetId: 'kokoro-init-slow-release',
          timeoutMs: 50,
          signal: controller.signal,
        },
        {
          kokoroNativeModule,
          fs: await createInstalledKokoroFs({ packId: 'kokoro-init-slow-release',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0' }, { File: class {
              }, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      controller.abort();

      expect(kokoroNativeModule.cancelInitialization).toHaveBeenCalledOnce();
      expect(kokoroNativeModule.releaseAssetsDir).not.toHaveBeenCalled();
      expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);

      let settled = false;
      void preparation.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveCancellation();
      await expect(preparation).rejects.toThrow('aborted');
      resolveInitialization();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
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
        listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
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
          fs: await createInstalledKokoroFs({ packId: 'kokoro-timeout-cleanup-test',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '1.0.0',
              voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }] }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
          resolveOutWavPath: () => 'file:///tmp/out.wav',
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
        fs: await createInstalledKokoroFs({ packId: 'kokoro-test-v0',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '1.0.0' }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
        resolveOutWavPath: () => 'file:///tmp/out.wav',
      },
    );

    expect(kokoroNativeModule.synthesizeToWavFile).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: 'af_bella', sid: 1 }),
    );
  });

  it('forwards model pack download progress (including file) during prepare', async () => {
    const onProgress = vi.fn();
    const { fs, files } = createMemFs();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const manifest = { packId: 'kokoro-test', kind: 'tts_sherpa', model: 'kokoro', version: '1.0.0',
      voices: [{ id: 'af_bella', title: 'Bella', sid: 0 }],
      files: [{ path: 'onnx/model_quantized.onnx', url: 'https://example.com/model.onnx', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }] };

    const kokoroNativeModule = {
      initialize: vi.fn().mockResolvedValue(undefined),
      listVoices: vi.fn().mockResolvedValue(loadedNativeVoices),
      synthesizeToWavFile: vi.fn().mockResolvedValue({ wavPath: 'file:///tmp/out.wav', sampleRate: 24000 }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    nativeArtifactDownload.mockImplementation((url: string, uri: string, options: unknown,
      progress: (value: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void) => ({
      async downloadAsync() {
        progress({ totalBytesWritten: 1, totalBytesExpectedToWrite: bytes.length });
        files.set(uri, bytes);
        progress({ totalBytesWritten: bytes.length, totalBytesExpectedToWrite: bytes.length });
        return { uri, status: 200, headers: {}, mimeType: null };
      },
      async pauseAsync() { return { url, fileUri: uri, options }; },
      async cancelAsync() {},
    }));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (!new URL(String(input)).pathname.endsWith('manifest.json')) throw new Error('artifact_fetch_crossed_js_boundary');
      return Response.json(manifest);
    });
    try {
      await prepareKokoroTts(
      {
        assetSetId: 'kokoro-test',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onProgress,
      },
      {
        kokoroNativeModule,
        fs: { ...fs, Paths: { ...fs.Paths, cache: 'file:///tmp/' } },
      },
    );

    expect(onProgress).toHaveBeenCalledWith({
      loaded: 1, total: 4, file: 'onnx/model_quantized.onnx', verified: 0, filesDone: 0, filesTotal: 1,
    });
    expect(files.get('file:///docs/happier/voice/modelPacks/kokoro-test/onnx/model_quantized.onnx')).toEqual(bytes);
    } finally {
      vi.unstubAllGlobals();
      nativeArtifactDownload.mockReset();
    }
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
      fs: await createInstalledKokoroFs({ packId: 'kokoro-cache-poison-test',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: '1.0.0' }, { File, Paths: { cache: 'file:///tmp/', document: 'file:///docs/' } } as any),
      resolveOutWavPath: () => 'file:///tmp/out.wav',
    };

    const baseOpts = {
      text: 'hello',
      assetSetId: 'kokoro-cache-poison-test',
      voiceId: 'af_bella',
      speed: 1,
      timeoutMs: 5000,
    };

    // An unavailable catalog cannot establish a named speaker identity.
    await expect(synthesizeKokoroWav({ ...baseOpts, signal: new AbortController().signal }, overrides))
      .rejects.toThrow('kokoro_voice_unavailable');
    expect(kokoroNativeModule.synthesizeToWavFile).not.toHaveBeenCalled();

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
