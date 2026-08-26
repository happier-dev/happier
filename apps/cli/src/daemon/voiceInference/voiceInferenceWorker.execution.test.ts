import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createInferenceDiagnostics } from '@/daemon/inference/inferenceDiagnostics';

import { createVoiceInferenceWorkerExecution } from './voiceInferenceWorker.execution';
import { resolveVoiceInferencePaths } from './voiceInferencePaths';
import type {
  VoiceInferenceRuntime,
  VoiceInferenceRuntimeSynthesizeResult,
  VoiceInferenceStreamingTranscriptionSession,
} from './voiceInferenceRuntimeTypes';
import type { VoiceInferenceWorkerLifecycleContext } from './voiceInferenceWorker.lifecycle';

const manifest: ModelPackManifest = {
  packId: 'pack-1',
  kind: 'stt_sherpa',
  model: 'zipformer',
  version: '2026-07-13',
  files: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function createExecution(runtime: VoiceInferenceRuntime) {
  let diagnostics = createInferenceDiagnostics({ runtimeState: 'ready' });
  const lifecycle: VoiceInferenceWorkerLifecycleContext = {
    isStopped: () => false,
    getDiagnostics: () => diagnostics,
    setDiagnostics: (next) => { diagnostics = next; },
    runExclusive: async (_packId, work) => await work(),
    runLifecycleExclusive: async (_packId, work) => await work(),
    warmRuntimeForPack: async () => ({ runtime, packDir: '/tmp/pack-1', manifest }),
  };
  return createVoiceInferenceWorkerExecution({ lifecycle });
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

describe('createVoiceInferenceWorkerExecution request lifecycle', () => {
  it('keeps a healthy runtime ready when a direct TTS result exceeds the IPC output ceiling', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => {
        throw Object.assign(new Error('voice_inference_tts_output_too_large'), { code: 'output_too_large' });
      }),
      transcribeAudio: vi.fn(async () => ({ text: 'unused', language: null })),
    };
    let diagnostics = createInferenceDiagnostics({ runtimeState: 'ready' });
    const lifecycle: VoiceInferenceWorkerLifecycleContext = {
      isStopped: () => false,
      getDiagnostics: () => diagnostics,
      setDiagnostics: (next) => { diagnostics = next; },
      runExclusive: async (_packId, work) => await work(),
      runLifecycleExclusive: async (_packId, work) => await work(),
      warmRuntimeForPack: async () => ({ runtime, packDir: '/tmp/pack-1', manifest }),
    };
    const execution = createVoiceInferenceWorkerExecution({ lifecycle });

    await expect(execution.synthesizeTts({
      requestId: 'too-large-output',
      text: 'hello',
      packId: 'pack-1',
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({ code: 'output_too_large' });

    expect(diagnostics.runtimeState).toBe('ready');
  });

  it('settles an already-aborted creation when its lease rejects before running work', async () => {
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: vi.fn(async () => { throw new Error('unused'); }),
      transcribeAudio: vi.fn(async () => { throw new Error('unused'); }),
      createStreamingTranscriptionSession: vi.fn(async () => { throw new Error('must not run'); }),
    };
    let diagnostics = createInferenceDiagnostics({ runtimeState: 'ready' });
    const lifecycle: VoiceInferenceWorkerLifecycleContext = {
      isStopped: () => false,
      getDiagnostics: () => diagnostics,
      setDiagnostics: (next) => { diagnostics = next; },
      runExclusive: async (_packId, work, options) => {
        if (options?.signal?.aborted) {
          throw Object.assign(new Error('inference_cancelled'), { code: 'cancelled' });
        }
        return await work();
      },
      runLifecycleExclusive: async (_packId, work) => await work(),
      warmRuntimeForPack: async () => ({ runtime, packDir: '/tmp/pack-1', manifest }),
    };
    const execution = createVoiceInferenceWorkerExecution({ lifecycle });
    const lifetime = new AbortController();
    lifetime.abort();

    const outcome = await Promise.race([
      execution.createStreamingTranscriptionSession({
        requestId: 'pre-aborted-stream-session',
        packId: 'pack-1',
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
    let diagnostics = createInferenceDiagnostics({ runtimeState: 'ready' });
    const lifecycle: VoiceInferenceWorkerLifecycleContext = {
      isStopped: () => false,
      getDiagnostics: () => diagnostics,
      setDiagnostics: (next) => { diagnostics = next; },
      runExclusive: async (_packId, work) => await work(),
      runLifecycleExclusive: async (_packId, work) => await work(),
      warmRuntimeForPack: async () => ({ runtime, packDir: '/tmp/pack-1', manifest }),
    };
    const execution = createVoiceInferenceWorkerExecution({ lifecycle });
    const lifetime = new AbortController();
    const creating = execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-session',
      packId: 'pack-1',
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
    const execution = createExecution(runtime);
    const lifetime = new AbortController();
    const requestId = 'late-tts-result';
    const pending = execution.synthesizeTts({
      requestId,
      text: 'hello',
      packId: 'pack-1',
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
    const execution = createExecution(runtime);

    try {
      await expect(execution.synthesizeTts({
        requestId,
        text: 'hello',
        packId: 'pack-1',
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
    const execution = createExecution(runtime);
    const { tempDir } = resolveVoiceInferencePaths();
    const fileName = 'late-stt-result.wav';
    const filePath = join(tempDir, fileName);
    await writeFile(filePath, createWavHeader());
    const lifetime = new AbortController();
    const pending = execution.transcribeAudio({
      requestId: 'late-stt-result',
      uploadId: 'upload-late-stt-result',
      filePath,
      inputMimeType: 'audio/wav',
      packId: 'pack-1',
      language: null,
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      signal: lifetime.signal,
    });
    await vi.waitFor(() => expect(runtime.transcribeAudio).toHaveBeenCalledOnce());

    lateTranscription.resolve({ text: 'late transcript', language: 'en' });
    lifetime.abort();

    try {
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      expect(await readdir(tempDir)).not.toContain(fileName);
    } finally {
      await rm(filePath, { force: true });
    }
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
    const execution = createExecution(runtime);
    const lifetime = new AbortController();
    const session = await execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-append',
      packId: 'pack-1',
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
    const execution = createExecution(runtime);
    const lifetime = new AbortController();
    const session = await execution.createStreamingTranscriptionSession({
      requestId: 'late-stream-finish',
      packId: 'pack-1',
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
