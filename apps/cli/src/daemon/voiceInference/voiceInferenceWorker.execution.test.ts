import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelPackManifestSchema } from '@happier-dev/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import { startVoiceInferenceWorker, type VoiceInferenceWorkerHandle } from './voiceInferenceWorker';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import type {
  VoiceInferenceRuntime,
  VoiceInferenceRuntimeSynthesizeResult,
  VoiceInferenceStreamingTranscriptionSession,
} from './voiceInferenceRuntimeTypes';
const sttPackId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const ttsPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
const frenchPackId = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const workers: VoiceInferenceWorkerHandle[] = [];
const homes: string[] = [];
let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function createExecution(runtime: VoiceInferenceRuntime) {
  const worker = await startVoiceInferenceWorker({ runtimeLoader: async () => runtime });
  workers.push(worker);
  return worker;
}

function createWavHeader(): Buffer {
  return Buffer.from('RIFF....WAVE', 'ascii');
}

async function removeTempArtifacts(prefix: string): Promise<void> {
  const { tempDir } = resolveVoiceInferencePaths();
  const paths = await readdir(tempDir);
  await Promise.all(paths
    .filter((path) => path.startsWith(prefix))
    .map(async (path) => await rm(join(tempDir, path), { force: true })));
}

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'happier-worker-execution-'));
  homes.push(home);
  process.env.HAPPIER_HOME_DIR = home;
  reloadConfiguration();
  const bytes = Buffer.from('native inference model boundary fixture');
  for (const [packId, kind, model] of [[sttPackId, 'stt_sherpa', 'zipformer'], [ttsPackId, 'tts_sherpa', 'kokoro']] as const) {
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, packId);
    await mkdir(packDir, { recursive: true });
    const manifest = ModelPackManifestSchema.parse({
      packId, kind, model, version: 'fixture-v1',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }],
    });
    await writeFile(join(packDir, 'pack.json'), JSON.stringify(manifest));
    await writeFile(join(packDir, 'model.onnx'), bytes);
  }
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
  envScope.restore();
  envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  reloadConfiguration();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('createVoiceInferenceWorkerExecution request lifecycle', () => {
  it.each(['fr', 'fr-FR'])('selects the catalog French pack for %s instead of the selected English pack', async language => {
    const packDir = join(resolveVoiceInferencePaths().packsRootDir, frenchPackId);
    await mkdir(packDir, { recursive: true });
    const bytes = Buffer.from('French native model boundary fixture');
    await writeFile(join(packDir, 'pack.json'), JSON.stringify({
      packId: frenchPackId, kind: 'stt_sherpa', model: frenchPackId, version: 'fixture-v1',
      files: [{ path: 'model.onnx', url: 'https://example.test/model.onnx',
        sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }],
    }));
    await writeFile(join(packDir, 'model.onnx'), bytes);
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async input => ({ text: input.packId === frenchPackId ? 'Bonjour' : 'unrelated English', language: input.language }),
    };
    const worker = await createExecution(runtime);
    const filePath = join(resolveVoiceInferencePaths().tempDir, 'french.wav');
    await writeFile(filePath, createWavHeader());
    await expect(worker.transcribeAudio({
      requestId: 'french', uploadId: 'french', filePath, inputMimeType: 'audio/wav',
      packId: sttPackId, language,
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    })).resolves.toMatchObject({ text: 'Bonjour', modelPackId: frenchPackId });
  });

  it.each([
    ['fr', 'model_not_installed'],
    ['ja', 'runtime_unavailable'],
  ])('returns typed unavailability for absent %s STT instead of invoking English STT', async (language, code) => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async () => ({ text: 'unrelated English', language: 'en' }),
    };
    const worker = await createExecution(runtime);
    const filePath = join(resolveVoiceInferencePaths().tempDir, 'missing-french.wav');
    await writeFile(filePath, createWavHeader());
    await expect(worker.transcribeAudio({
      requestId: 'missing-french', uploadId: 'missing-french', filePath, inputMimeType: 'audio/wav',
      packId: sttPackId, language,
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    })).rejects.toMatchObject({ code });
    expect(await readdir(resolveVoiceInferencePaths().tempDir)).not.toContain('missing-french.wav');
  });

  it('refuses French streaming when the catalog has no matching streaming pack', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async () => { throw new Error('unused'); },
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async () => ({ events: [] }), finish: async () => ({ text: 'English', language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    };
    const worker = await createExecution(runtime);
    await expect(worker.createStreamingTranscriptionSession({
      requestId: 'french-stream', packId: sttPackId, language: 'fr',
      format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
    })).rejects.toMatchObject({ code: 'runtime_unavailable' });
  });

  it('warms a receiver model while the sender keeps its streaming lease and PCM progress', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async () => { throw new Error('unused'); },
      createStreamingTranscriptionSession: async ({ requestId }) => ({
        appendPcm16: async ({ seq }) => ({ events: [{ type: 'partial', seq, text: requestId, isEndpoint: false, confidence: null }] }),
        finish: async () => ({ text: requestId, language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    };
    const worker = await createExecution(runtime);
    const input = { packId: sttPackId, language: null, format: {
      sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le',
    } } as const;
    const first = await worker.createStreamingTranscriptionSession({ ...input, requestId: 'sender' });
    const warming = worker.warmModelPack(sttPackId);
    let warmed = false;
    void warming.then(() => { warmed = true; });
    let receiver: Awaited<ReturnType<typeof worker.createStreamingTranscriptionSession>> | undefined;
    try {
      await expect(first.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([1, 2]) })).resolves.toMatchObject({
        events: [{ text: 'sender' }],
      });
      await vi.waitFor(() => expect(warmed).toBe(true));
      receiver = await worker.createStreamingTranscriptionSession({ ...input, requestId: 'receiver' });
      const results = await Promise.all([first, receiver].map(session => session.appendPcm16({ seq: 1, pcm16Bytes: new Uint8Array([3, 4]) })));
      expect(results.map(result => result.events[0])).toMatchObject([{ text: 'sender' }, { text: 'receiver' }]);
    } finally {
      await first.cancel();
      await receiver?.cancel();
      await warming;
    }
  });

  it('admits a second live STT client while serializing native work and retaining model custody', async () => {
    const appendGate = deferred<void>();
    const entered: string[] = [];
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async () => { throw new Error('unused'); },
      createStreamingTranscriptionSession: async ({ requestId }) => ({
        appendPcm16: async () => {
          entered.push(requestId);
          if (requestId === 'first-client') await appendGate.promise;
          return { events: [] };
        },
        finish: async () => ({ text: requestId, language: 'en', events: [] }),
        cancel: async () => {}, close: async () => {},
      }),
    };
    const worker = await createExecution(runtime);
    const input = { packId: sttPackId, language: null, format: {
      sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le',
    } } as const;
    const first = await worker.createStreamingTranscriptionSession({ ...input, requestId: 'first-client' });
    let second: Awaited<ReturnType<typeof worker.createStreamingTranscriptionSession>> | undefined;
    const secondReady = worker.createStreamingTranscriptionSession({ ...input, requestId: 'receiver-client' })
      .then(session => { second = session; return session; });
    try {
      await vi.waitFor(() => expect(second).toBeDefined());
      const firstAppend = first.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]) });
      await vi.waitFor(() => expect(entered).toEqual(['first-client']));
      const secondAppend = second!.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]) });
      let removed = false;
      const removal = worker.removeModel(sttPackId).then(() => { removed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(entered).toEqual(['first-client']);
      expect(removed).toBe(false);
      appendGate.resolve();
      await Promise.all([firstAppend, secondAppend]);
      expect(entered).toEqual(['first-client', 'receiver-client']);
      await expect(first.finish({ finalSeq: 0 })).resolves.toMatchObject({ text: 'first-client' });
      expect(removed).toBe(false);
      // A queued remove must not block the existing receiver's final native operation.
      await expect(second!.finish({ finalSeq: 0 })).resolves.toMatchObject({ text: 'receiver-client' });
      await removal;
      expect(removed).toBe(true);
    } finally {
      appendGate.resolve();
      await first.cancel();
      await (await secondReady).cancel();
    }
  });

  it('keeps a healthy runtime ready when a direct TTS result exceeds the IPC output ceiling', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => {
        throw Object.assign(new Error('voice_inference_tts_output_too_large'), { code: 'output_too_large' });
      }),
      transcribeAudio: vi.fn(async () => ({ text: 'unused', language: null })),
    };
    const execution = await createExecution(runtime);

    await expect(execution.synthesizeTts({
      requestId: 'too-large-output',
      text: 'hello',
      packId: ttsPackId,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({ code: 'output_too_large' });

    await expect(execution.getStatus()).resolves.toMatchObject({ serviceState: 'ready' });
  });

  it('settles an already-aborted creation when its lease rejects before running work', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
      createStreamingTranscriptionSession: vi.fn(async () => { throw new Error('must not run'); }),
    };
    const execution = await createExecution(runtime);
    const lifetime = new AbortController();
    lifetime.abort();

    const outcome = await Promise.race([
      execution.createStreamingTranscriptionSession({
        requestId: 'pre-aborted-stream-session',
        packId: sttPackId,
        language: null,
        format: {
          sampleRateHz: 16_000,
          channelCount: 1,
          bitsPerSample: 16,
          ffmpegCodec: 'pcm_s16le',
        },
        signal: lifetime.signal,
      }).then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 50);
      }),
    ]);

    expect(outcome).toMatchObject({ kind: 'rejected', error: { code: 'cancelled' } });
    expect(runtime.createStreamingTranscriptionSession).not.toHaveBeenCalled();
  });

  it('rejects and cleans a runtime session that arrives after its lifetime was aborted', async () => {
    const lateSession = deferred<VoiceInferenceStreamingTranscriptionSession>();
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
      createStreamingTranscriptionSession: vi.fn(async () => await lateSession.promise),
    };
    const execution = await createExecution(runtime);
    const lifetime = new AbortController();
    const creating = execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-session',
      packId: sttPackId,
      language: null,
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
      signal: lifetime.signal,
    });
    await vi.waitFor(() => expect(runtime.createStreamingTranscriptionSession).toHaveBeenCalledOnce());

    lifetime.abort();
    lateSession.resolve({
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: runtimeCancel,
      close: runtimeClose,
    });

    await expect(creating).rejects.toMatchObject({ code: 'cancelled' });
    expect(runtimeCancel).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it('lets cancellation win over a late TTS result without exposing a staged output', async () => {
    const lateSynthesis = deferred<VoiceInferenceRuntimeSynthesizeResult>();
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => await lateSynthesis.promise),
      transcribeAudio: vi.fn(async () => ({ text: 'unused', language: null })),
    };
    const execution = await createExecution(runtime);
    const lifetime = new AbortController();
    const requestId = 'late-tts-result';
    const pending = execution.synthesizeTts({
      requestId,
      text: 'hello',
      packId: ttsPackId,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: lifetime.signal,
    });
    await vi.waitFor(() => expect(runtime.synthesizeTts).toHaveBeenCalledOnce());

    lateSynthesis.resolve({
      bytes: Buffer.from('late audio'),
      output: { codec: 'wav', mimeType: 'audio/wav' },
      name: 'late.wav',
    });
    lifetime.abort();

    try {
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      const { tempDir } = resolveVoiceInferencePaths();
      expect((await readdir(tempDir)).filter((path) => path.startsWith(`${requestId}-`))).toEqual([]);
    } finally {
      await removeTempArtifacts(`${requestId}-`);
    }
  });

  it('removes an output staged when cancellation happens while its bytes are written', async () => {
    const lifetime = new AbortController();
    const requestId = 'cancelled-tts-write';
    const synthesized: VoiceInferenceRuntimeSynthesizeResult = {
      bytes: Buffer.from('placeholder'),
      output: { codec: 'wav', mimeType: 'audio/wav' },
      name: 'staged.wav',
    };
    Object.defineProperty(synthesized, 'bytes', {
      get: () => {
        lifetime.abort();
        return Buffer.from('late staged audio');
      },
    });
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => synthesized),
      transcribeAudio: vi.fn(async () => ({ text: 'unused', language: null })),
    };
    const execution = await createExecution(runtime);

    try {
      await expect(execution.synthesizeTts({
        requestId,
        text: 'hello',
        packId: ttsPackId,
        voiceId: null,
        speed: null,
        output: { codec: 'wav', mimeType: 'audio/wav' },
        signal: lifetime.signal,
      })).rejects.toMatchObject({ code: 'cancelled' });
      const { tempDir } = resolveVoiceInferencePaths();
      expect((await readdir(tempDir)).filter((path) => path.startsWith(`${requestId}-`))).toEqual([]);
    } finally {
      await removeTempArtifacts(`${requestId}-`);
    }
  });

  it('lets cancellation win over a late STT result and removes the uploaded audio', async () => {
    const lateTranscription = deferred<Readonly<{ text: string; language: string | null }>>();
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => await lateTranscription.promise),
    };
    const execution = await createExecution(runtime);
    const { tempDir } = resolveVoiceInferencePaths();
    const fileName = 'late-stt-result.wav';
    const filePath = join(tempDir, fileName);
    await writeFile(filePath, createWavHeader());
    const lifetime = new AbortController();
    let captured = false;
    const pending = execution.transcribeAudio({
      requestId: 'late-stt-result',
      uploadId: 'upload-late-stt-result',
      filePath,
      inputMimeType: 'audio/wav',
      packId: sttPackId,
      language: null,
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      signal: lifetime.signal,
      onTranscribed: async () => { captured = true; },
    });
    await vi.waitFor(() => expect(runtime.transcribeAudio).toHaveBeenCalledOnce());

    lateTranscription.resolve({ text: 'late transcript', language: 'en' });
    lifetime.abort();

    try {
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(captured).toBe(false);
      expect(await readdir(tempDir)).not.toContain(fileName);
    } finally {
      await rm(filePath, { force: true });
    }
  });

  it('keeps completed STT input available for capture without holding the inference lease', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => { throw new Error('unused'); },
      transcribeAudio: async ({ requestId }) => ({ text: requestId, language: 'en' }),
    };
    const execution = await createExecution(runtime);
    const { tempDir } = resolveVoiceInferencePaths();
    const filePath = join(tempDir, 'completed-input.wav');
    const nextFilePath = join(tempDir, 'next-input.wav');
    const audio = createWavHeader();
    await writeFile(filePath, audio);
    await writeFile(nextFilePath, audio);
    const captureRelease = deferred<void>();
    let capturedAudio: Buffer | undefined;
    const input = {
      uploadId: 'completed-input', filePath, inputMimeType: 'audio/wav',
      packId: sttPackId, language: null,
      normalization: {
        inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false,
      },
    } as const;
    const pending = execution.transcribeAudio({
      ...input, requestId: 'completed-input',
      onTranscribed: async () => {
        capturedAudio = await readFile(filePath);
        await captureRelease.promise;
        throw new Error('diagnostic_storage_unavailable');
      },
    });
    try {
      await vi.waitFor(() => expect(capturedAudio).toEqual(audio));
      await expect(execution.transcribeAudio({
        ...input, requestId: 'next-input', uploadId: 'next-input', filePath: nextFilePath,
      })).resolves.toMatchObject({ text: 'next-input' });
    } finally {
      captureRelease.resolve();
    }
    await expect(pending).resolves.toMatchObject({ text: 'completed-input' });
    expect(await readdir(tempDir)).not.toContain('completed-input.wav');
    expect(await readdir(tempDir)).not.toContain('next-input.wav');
  });

  it('lets cancellation win over a late streaming append result', async () => {
    const lateAppend = deferred<Readonly<{ events: readonly [] }>>();
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const appendPcm16 = vi.fn(async () => await lateAppend.promise);
    const runtimeSession: VoiceInferenceStreamingTranscriptionSession = {
      appendPcm16,
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: runtimeCancel,
      close: runtimeClose,
    };
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    };
    const execution = await createExecution(runtime);
    const lifetime = new AbortController();
    const session = await execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-append',
      packId: sttPackId,
      language: null,
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
      signal: lifetime.signal,
    });
    const pending = session.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]) });
    await vi.waitFor(() => expect(appendPcm16).toHaveBeenCalledOnce());

    lateAppend.resolve({ events: [] });
    lifetime.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(runtimeCancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtimeClose).toHaveBeenCalledOnce());
  });

  it('lets cancellation win over a late streaming final result', async () => {
    const lateFinish = deferred<Readonly<{ text: string; language: string | null; events: readonly [] }>>();
    const runtimeCancel = vi.fn(async () => {});
    const runtimeClose = vi.fn(async () => {});
    const finish = vi.fn(async () => await lateFinish.promise);
    const runtimeSession: VoiceInferenceStreamingTranscriptionSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish,
      cancel: runtimeCancel,
      close: runtimeClose,
    };
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
      createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
    };
    const execution = await createExecution(runtime);
    const lifetime = new AbortController();
    const session = await execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-finish',
      packId: sttPackId,
      language: null,
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
      signal: lifetime.signal,
    });
    const pending = session.finish({ finalSeq: 0 });
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());

    lateFinish.resolve({ text: 'late final', language: 'en', events: [] });
    lifetime.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(runtimeCancel).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtimeClose).toHaveBeenCalledOnce());
  });
});
