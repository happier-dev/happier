import type { ModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createInferenceDiagnostics } from '@/daemon/inference/inferenceDiagnostics';

import { createVoiceInferenceWorkerExecution } from './voiceInferenceWorker.execution';
import type { VoiceInferenceRuntime, VoiceInferenceStreamingTranscriptionSession } from './voiceInferenceRuntimeTypes';
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

describe('createVoiceInferenceWorkerExecution streaming lifecycle', () => {
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
});
