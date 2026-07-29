import type { ModelPackManifest } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { VoiceInferenceRuntime } from '../voiceInferenceRuntimeTypes';
import { createVoiceInferenceError } from '../voiceInferenceWorker.shared';
import {
  createVoiceInferenceWorkerFrameDecoder,
  encodeVoiceInferenceWorkerFrame,
  type VoiceInferenceWorkerRequestFrame,
  type VoiceInferenceWorkerResponseFrame,
} from './ipcProtocol';
import {
  createVoiceInferenceWorkerRunner,
  type VoiceInferenceWorkerTransport,
} from './workerRunner';

const manifest: ModelPackManifest = {
  packId: 'pack-1',
  kind: 'tts_sherpa',
  model: 'kokoro',
  version: '2026-04-17',
  files: [],
};
const publicRuntimeDescriptor = {
  family: 'sherpa_zipformer_streaming' as const,
  artifacts: {
    encoder: { type: 'file' as const, path: 'encoder.onnx' },
    decoder: { type: 'file' as const, path: 'decoder.onnx' },
    joiner: { type: 'file' as const, path: 'joiner.onnx' },
    tokens: { type: 'file' as const, path: 'tokens.txt' },
  },
  abiVersion: 1,
  minHostVersion: '0.2.10',
  platforms: ['darwin' as const],
  architectures: ['arm64' as const],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

/**
 * In-memory transport (boundary mock of the child stdio). Captures all response frames the
 * runner emits and lets the test feed request frames.
 */
function createFakeTransport() {
  let dataListener: ((chunk: Buffer) => void) | null = null;
  let closeListener: (() => void) | null = null;
  const decoder = createVoiceInferenceWorkerFrameDecoder();
  const responses: VoiceInferenceWorkerResponseFrame[] = [];

  const transport: VoiceInferenceWorkerTransport = {
    onData: (listener) => {
      dataListener = listener;
    },
    write: (frame) => {
      for (const decoded of decoder.push(frame)) {
        responses.push(decoded as VoiceInferenceWorkerResponseFrame);
      }
    },
    onClose: (listener) => {
      closeListener = listener;
    },
  };

  return {
    transport,
    responses,
    sendRequest: (frame: VoiceInferenceWorkerRequestFrame) => dataListener?.(encodeVoiceInferenceWorkerFrame(frame)),
    close: () => closeListener?.(),
  };
}

describe('voice inference worker runner', () => {
  it('answers a ping with a ready frame', async () => {
    const fake = createFakeTransport();
    createVoiceInferenceWorkerRunner({
      transport: fake.transport,
      loadRuntime: async () => null,
    });
    fake.sendRequest({ kind: 'ping', id: 'p-1' });
    await vi.waitFor(() => expect(fake.responses).toContainEqual({ kind: 'ready', id: 'p-1' }));
  });

  it('dispatches synthesize to the engine and returns base64 audio plus warm snapshots', async () => {
    const fake = createFakeTransport();
    const runtime: VoiceInferenceRuntime = {
      warmModel: async () => {},
      synthesizeTts: async () => ({ bytes: Buffer.from('child-audio'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'c.wav' }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
    };
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({ kind: 'warm', id: 'w-1', packId: 'pack-1', packDir: '/tmp/pack-1', manifest });
    await vi.waitFor(() => expect(fake.responses).toContainEqual({ kind: 'result', id: 'w-1', result: { kind: 'warm' } }));
    expect(fake.responses).toContainEqual({ kind: 'snapshot', packId: 'pack-1', runtimeState: 'warming', residentMemoryBytes: null });
    expect(fake.responses).toContainEqual({ kind: 'snapshot', packId: 'pack-1', runtimeState: 'ready', residentMemoryBytes: null });

    fake.sendRequest({
      kind: 'synthesize', id: 's-1', requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.waitFor(() => {
      const result = fake.responses.find((frame) => frame.kind === 'result' && frame.id === 's-1');
      expect(result).toBeDefined();
    });
    const synthResult = fake.responses.find((frame) => frame.kind === 'result' && frame.id === 's-1');
    if (synthResult?.kind === 'result' && synthResult.result.kind === 'synthesize') {
      expect(Buffer.from(synthResult.result.bytesBase64, 'base64').toString('utf8')).toBe('child-audio');
    } else {
      throw new Error('expected synthesize result');
    }
  });

  it('maps engine error codes into worker error frames', async () => {
    const fake = createFakeTransport();
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => {
        throw createVoiceInferenceError('unsupported_codec', 'voice_inference_unsupported_codec');
      },
      transcribeAudio: async () => ({ text: 'unused', language: null }),
    };
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'synthesize', id: 's-err', requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.waitFor(() => {
      const err = fake.responses.find((frame) => frame.kind === 'error' && frame.id === 's-err');
      expect(err).toMatchObject({ kind: 'error', id: 's-err', code: 'unsupported_codec' });
    });
  });

  it('dispatches streaming STT start, append, finish, and cancel to a runtime session', async () => {
    const fake = createFakeTransport();
    const runtimeSession = {
      appendPcm16: vi.fn(async ({ seq, pcm16Bytes }: { seq: number; pcm16Bytes: Uint8Array }) => ({
        events: [{ type: 'partial', seq, text: `bytes:${pcm16Bytes.byteLength}`, isEndpoint: false, confidence: null }],
      })),
      finish: vi.fn(async ({ finalSeq }: { finalSeq: number }) => ({
        text: 'hello',
        language: 'en',
        events: [{ type: 'final', seq: finalSeq, text: 'hello', language: 'en', modelPackId: 'pack-1' }],
      })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const createStreamingTranscriptionSession = vi.fn(async () => runtimeSession);
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: null }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
      createStreamingTranscriptionSession,
    } as unknown as VoiceInferenceRuntime;
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'stt_stream_start',
      id: 'stream-start-1',
      requestId: 'stt-stream-1',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      runtimeDescriptor: publicRuntimeDescriptor,
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
      language: 'en',
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    } as unknown as VoiceInferenceWorkerRequestFrame);
    await vi.waitFor(() => {
      expect(fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-start-1')).toBeDefined();
    });
    const startResult = fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-start-1');
    if (startResult?.kind !== 'result' || startResult.result.kind !== 'stt_stream_start') {
      throw new Error('expected streaming start result');
    }

    fake.sendRequest({
      kind: 'stt_stream_append',
      id: 'stream-append-1',
      sessionId: startResult.result.sessionId,
      seq: 0,
      pcm16Base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
    } as unknown as VoiceInferenceWorkerRequestFrame);
    fake.sendRequest({
      kind: 'stt_stream_finish',
      id: 'stream-finish-1',
      sessionId: startResult.result.sessionId,
      finalSeq: 0,
    } as unknown as VoiceInferenceWorkerRequestFrame);
    await vi.waitFor(() => {
      expect(fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-finish-1')).toBeDefined();
    });

    fake.sendRequest({
      kind: 'stt_stream_start',
      id: 'stream-start-2',
      requestId: 'stt-stream-2',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: 'en',
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    } as unknown as VoiceInferenceWorkerRequestFrame);
    await vi.waitFor(() => {
      expect(fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-start-2')).toBeDefined();
    });
    const cancelStartResult = fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-start-2');
    if (cancelStartResult?.kind !== 'result' || cancelStartResult.result.kind !== 'stt_stream_start') {
      throw new Error('expected second streaming start result');
    }

    fake.sendRequest({
      kind: 'stt_stream_cancel',
      id: 'stream-cancel-1',
      sessionId: cancelStartResult.result.sessionId,
    } as unknown as VoiceInferenceWorkerRequestFrame);
    await vi.waitFor(() => {
      expect(fake.responses.find((frame) => frame.kind === 'result' && frame.id === 'stream-cancel-1')).toBeDefined();
    });

    expect(createStreamingTranscriptionSession).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stt-stream-1',
      packId: 'pack-1',
      language: 'en',
      runtimeDescriptor: publicRuntimeDescriptor,
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
    }));
    expect(runtimeSession.appendPcm16).toHaveBeenCalledWith(expect.objectContaining({
      seq: 0,
      pcm16Bytes: expect.any(Uint8Array),
    }));
    expect(runtimeSession.finish).toHaveBeenCalledWith(expect.objectContaining({ finalSeq: 0 }));
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledTimes(2);
  });

  it('preserves the public stream_not_found lifecycle code for an unknown worker session', async () => {
    const fake = createFakeTransport();
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: null }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
      createStreamingTranscriptionSession: vi.fn(),
    } as unknown as VoiceInferenceRuntime;
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'stt_stream_append',
      id: 'missing-stream-append',
      sessionId: 'missing-stream',
      seq: 0,
      pcm16Base64: Buffer.from([0, 0]).toString('base64'),
    } as unknown as VoiceInferenceWorkerRequestFrame);

    await vi.waitFor(() => {
      expect(fake.responses.find((frame) => frame.kind === 'error' && frame.id === 'missing-stream-append')).toMatchObject({
        code: 'stream_not_found',
      });
    });
  });

  it('reports runtime_unavailable when the engine cannot load', async () => {
    const fake = createFakeTransport();
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => null });
    fake.sendRequest({
      kind: 'synthesize', id: 's-na', requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.waitFor(() => {
      const err = fake.responses.find((frame) => frame.kind === 'error' && frame.id === 's-na');
      expect(err).toMatchObject({ code: 'runtime_unavailable' });
    });
  });

  it('cancels an in-flight request when an abort frame targets it', async () => {
    const fake = createFakeTransport();
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: ({ signal }) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
    };
    const runner = createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'synthesize', id: 's-cancel', requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.waitFor(() => expect(runner.inFlightCount()).toBe(1));

    fake.sendRequest({ kind: 'abort', id: 'a-1', targetId: 's-cancel' });
    await vi.waitFor(() => {
      const err = fake.responses.find((frame) => frame.kind === 'error' && frame.id === 's-cancel');
      expect(err).toMatchObject({ code: 'cancelled' });
    });
    expect(runner.inFlightCount()).toBe(0);
  });

  it('cancels and closes a streaming session that arrives after transport disposal', async () => {
    const fake = createFakeTransport();
    const lateSession = deferred<Awaited<ReturnType<NonNullable<VoiceInferenceRuntime['createStreamingTranscriptionSession']>>>>();
    const resourceState: string[] = [];
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: null }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
      createStreamingTranscriptionSession: vi.fn(async () => await lateSession.promise),
    };
    const runner = createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'stt_stream_start',
      id: 'late-stream-start',
      requestId: 'late-stream-request',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: null,
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    });
    await vi.waitFor(() => expect(runtime.createStreamingTranscriptionSession).toHaveBeenCalledOnce());
    expect(runner.inFlightCount()).toBe(1);

    fake.close();
    lateSession.resolve({
      appendPcm16: async () => ({ events: [] }),
      finish: async () => ({ text: '', language: null, events: [] }),
      cancel: async () => { resourceState.push('cancelled'); },
      close: async () => { resourceState.push('closed'); },
    });

    await vi.waitFor(() => expect(resourceState).toEqual(['cancelled', 'closed']));
    expect(runner.inFlightCount()).toBe(0);
    expect(fake.responses).not.toContainEqual(expect.objectContaining({
      kind: 'result',
      id: 'late-stream-start',
    }));
  });

  it('cancels and closes an admitted streaming session when the transport closes', async () => {
    const fake = createFakeTransport();
    const resourceState: string[] = [];
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: null }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
      createStreamingTranscriptionSession: async () => ({
        appendPcm16: async () => ({ events: [] }),
        finish: async () => ({ text: '', language: null, events: [] }),
        cancel: async () => { resourceState.push('cancelled'); },
        close: async () => { resourceState.push('closed'); },
      }),
    };
    createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'stt_stream_start',
      id: 'admitted-stream-start',
      requestId: 'admitted-stream-request',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: null,
      format: {
        sampleRateHz: 16_000,
        channelCount: 1,
        bitsPerSample: 16,
        ffmpegCodec: 'pcm_s16le',
      },
    });
    await vi.waitFor(() => {
      expect(fake.responses).toContainEqual(expect.objectContaining({
        kind: 'result',
        id: 'admitted-stream-start',
      }));
    });

    fake.close();

    await vi.waitFor(() => expect(resourceState).toEqual(['cancelled', 'closed']));
  });

  it('aborts all in-flight work and stops accepting requests after the transport closes', async () => {
    const fake = createFakeTransport();
    let engineStarted = false;
    const runtime: VoiceInferenceRuntime = {
      synthesizeTts: ({ signal }) => new Promise((_, reject) => {
        engineStarted = true;
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        if (signal?.aborted) reject(new Error('aborted'));
      }),
      transcribeAudio: async () => ({ text: 'unused', language: null }),
    };
    const runner = createVoiceInferenceWorkerRunner({ transport: fake.transport, loadRuntime: async () => runtime });

    fake.sendRequest({
      kind: 'synthesize', id: 's-close', requestId: 'tts-1', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    // Wait until the engine call is actually in flight before closing the transport.
    await vi.waitFor(() => expect(engineStarted).toBe(true));
    expect(runner.inFlightCount()).toBe(1);

    fake.close();
    // The contract: closing the transport fails the in-flight request cleanly (it never
    // hangs) and the runner stops tracking it.
    await vi.waitFor(() => {
      const err = fake.responses.find((frame) => frame.kind === 'error' && frame.id === 's-close');
      expect(err).toMatchObject({ code: 'cancelled' });
    });
    expect(runner.inFlightCount()).toBe(0);
  });
});
