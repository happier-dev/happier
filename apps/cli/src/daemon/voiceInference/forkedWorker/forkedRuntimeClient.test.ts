import type { ModelPackManifest } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminationEvent } from '@/subprocess/supervision/types';

import {
  createForkedVoiceInferenceRuntimeClient,
  type VoiceInferenceWorkerChannel,
} from './forkedRuntimeClient';
import {
  createVoiceInferenceWorkerFrameDecoder,
  encodeVoiceInferenceWorkerFrame,
  type VoiceInferenceWorkerRequestFrame,
  type VoiceInferenceWorkerResponseFrame,
} from './ipcProtocol';

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

/**
 * In-memory worker channel (boundary mock of the child-process/IPC boundary). It decodes
 * frames the client sends and lets the test script the child's responses, including
 * crash/exit behavior. No internal client logic is mocked.
 */
function createFakeChannel(handlers: Readonly<{
  pid?: number;
  onRequest: (frame: VoiceInferenceWorkerRequestFrame, reply: (response: VoiceInferenceWorkerResponseFrame) => void) => void;
}>) {
  let dataListener: ((chunk: Buffer) => void) | null = null;
  let resolveTermination!: (event: TerminationEvent) => void;
  const termination = new Promise<TerminationEvent>((resolve) => {
    resolveTermination = resolve;
  });
  const decoder = createVoiceInferenceWorkerFrameDecoder();

  const reply = (response: VoiceInferenceWorkerResponseFrame) => {
    dataListener?.(encodeVoiceInferenceWorkerFrame(response));
  };

  const channel: VoiceInferenceWorkerChannel = {
    pid: handlers.pid ?? 4242,
    send: (frame) => {
      for (const decoded of decoder.push(frame)) {
        handlers.onRequest(decoded as VoiceInferenceWorkerRequestFrame, reply);
      }
    },
    onData: (listener) => {
      dataListener = listener;
    },
    waitForTermination: () => termination,
    terminate: () => resolveTermination({ type: 'signaled', signal: 'SIGTERM' }),
  };

  return {
    channel,
    reply,
    /** Push arbitrary raw bytes to the client's data path (corrupt/undecodable wire noise). */
    emitRaw: (bytes: Buffer) => dataListener?.(bytes),
    crash: () => resolveTermination({ type: 'exited', code: 139 }),
  };
}

describe('forked voice inference runtime client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('proxies synthesize over IPC and reassembles chunked TTS audio', async () => {
    const audio = Buffer.from('forked-tts-audio');
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          // Stream two chunks then a terminal result with the inline bytes empty.
          reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: 0, chunkBase64: audio.subarray(0, 6).toString('base64') });
          reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: 1, chunkBase64: audio.subarray(6).toString('base64') });
          reply({
            kind: 'result',
            id: frame.id,
            result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: '', name: 'forked.wav' },
          });
        }
      },
    });

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
    });

    const result = await client.synthesizeTts({
      requestId: 'tts-1',
      text: 'hello',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    expect(Buffer.from(result.bytes)).toEqual(audio);
    expect(result.name).toBe('forked.wav');
    await client.stop();
  });

  it('tolerates streaming STT partials and returns the final transcription', async () => {
    const emittedPartials: string[] = [];
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'transcribe') {
          emittedPartials.push('hel');
          reply({ kind: 'partial', id: frame.id, partialKind: 'stt', text: 'hel', language: 'en' });
          emittedPartials.push('hello');
          reply({ kind: 'partial', id: frame.id, partialKind: 'stt', text: 'hello', language: 'en' });
          reply({ kind: 'result', id: frame.id, result: { kind: 'transcribe', text: 'hello world', language: 'en' } });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
    });

    const result = await client.transcribeAudio({
      requestId: 'stt-1',
      filePath: '/tmp/upload.wav',
      inputMimeType: 'audio/wav',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      runtimeDescriptor: publicRuntimeDescriptor,
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
      language: 'en',
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    });
    // Partial frames must not break the terminal settle; the final transcription wins.
    expect(result).toEqual({ text: 'hello world', language: 'en' });
    expect(emittedPartials).toEqual(['hel', 'hello']);
    await client.stop();
  });

  it('proxies optional streaming STT sessions over IPC and rejects on worker crash', async () => {
    const seenRequests: VoiceInferenceWorkerRequestFrame[] = [];
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        seenRequests.push(frame);
        if (frame.kind === 'stt_stream_start') {
          if (frame.requestId === 'stt-stream-crash') {
            return;
          }
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId: 'worker-stream-1' } });
          return;
        }
        if (frame.kind === 'stt_stream_append') {
          reply({
            kind: 'result',
            id: frame.id,
            result: {
              kind: 'stt_stream_append',
              events: [{ type: 'partial', seq: frame.seq, text: 'hel', isEndpoint: false, confidence: null }],
            },
          });
          return;
        }
        if (frame.kind === 'stt_stream_finish') {
          reply({
            kind: 'result',
            id: frame.id,
            result: {
              kind: 'stt_stream_finish',
              text: 'hello',
              language: 'en',
              events: [{ type: 'final', seq: frame.finalSeq, text: 'hello', language: 'en', modelPackId: 'pack-1' }],
            },
          });
          return;
        }
        if (frame.kind === 'stt_stream_cancel') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_cancel' } });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });

    const session = await client.createStreamingTranscriptionSession?.({
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
    });
    expect(session).toBeDefined();

    await expect(session?.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) })).resolves.toEqual({
      events: [{ type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null }],
    });
    await expect(session?.finish({ finalSeq: 0 })).resolves.toEqual({
      text: 'hello',
      language: 'en',
      events: [{ type: 'final', seq: 0, text: 'hello', language: 'en', modelPackId: 'pack-1' }],
    });

    const cancelSession = await client.createStreamingTranscriptionSession?.({
      requestId: 'stt-stream-2',
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
    await expect(cancelSession?.cancel()).resolves.toBeUndefined();
    expect(seenRequests.map((frame) => frame.kind)).toEqual([
      'stt_stream_start',
      'stt_stream_append',
      'stt_stream_finish',
      'stt_stream_start',
      'stt_stream_cancel',
    ]);
    expect(seenRequests[0]).toMatchObject({
      runtimeDescriptor: publicRuntimeDescriptor,
      supportArtifacts: [{ type: 'file', kind: 'notice', path: 'NOTICE.txt' }],
    });

    const hangingSessionPromise = client.createStreamingTranscriptionSession?.({
      requestId: 'stt-stream-crash',
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
    fake.crash();
    await expect(hangingSessionPromise).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await client.stop();
  });

  it('still sends worker-session cleanup after the stream lifetime signal is aborted', async () => {
    const seenRequests: VoiceInferenceWorkerRequestFrame[] = [];
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        seenRequests.push(frame);
        if (frame.kind === 'stt_stream_start') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId: 'worker-stream-aborted' } });
        } else if (frame.kind === 'stt_stream_cancel') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_cancel' } });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });
    const lifetime = new AbortController();
    const session = await client.createStreamingTranscriptionSession?.({
      requestId: 'stt-stream-aborted-lifetime',
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
      signal: lifetime.signal,
    });
    lifetime.abort();

    await expect(session?.cancel()).resolves.toBeUndefined();
    await expect(session?.close()).resolves.toBeUndefined();
    await expect(session?.cancel()).resolves.toBeUndefined();
    expect(seenRequests.map((frame) => frame.kind)).toEqual([
      'stt_stream_start',
      'stt_stream_cancel',
    ]);
    await client.stop();
  });

  it('cleans up and rejects when stream creation completes after its lifetime was aborted', async () => {
    const seenRequests: VoiceInferenceWorkerRequestFrame[] = [];
    let captureStart!: (complete: (sessionId: string) => void) => void;
    const startCaptured = new Promise<(sessionId: string) => void>((resolve) => {
      captureStart = resolve;
    });
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        seenRequests.push(frame);
        if (frame.kind === 'stt_stream_start') {
          captureStart((sessionId) => {
            reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId } });
          });
        } else if (frame.kind === 'stt_stream_cancel') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_cancel' } });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });
    const lifetime = new AbortController();
    const creating = client.createStreamingTranscriptionSession?.({
      requestId: 'stt-stream-late-create',
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
      signal: lifetime.signal,
    });
    const completeStart = await startCaptured;

    lifetime.abort();
    completeStart('worker-stream-late-create');

    await expect(creating).rejects.toMatchObject({ code: 'cancelled' });
    expect(seenRequests.map((frame) => frame.kind)).toEqual([
      'stt_stream_start',
      'abort',
      'stt_stream_cancel',
    ]);
    await client.stop();
  });

  it('terminates the worker when stream cleanup cannot be sent and remains one-shot', async () => {
    let terminateCount = 0;
    const seenRequests: VoiceInferenceWorkerRequestFrame[] = [];
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        seenRequests.push(frame);
        if (frame.kind === 'stt_stream_start') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId: 'worker-stream-send-failure' } });
        } else if (frame.kind === 'stt_stream_cancel') {
          throw new Error('cleanup transport failed');
        }
      },
    });
    const channel: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      terminate: () => {
        terminateCount += 1;
        fake.channel.terminate();
      },
    };
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => channel });
    const session = await client.createStreamingTranscriptionSession?.({
      requestId: 'stt-stream-cleanup-send-failure',
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

    await expect(session?.cancel()).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await expect(session?.close()).resolves.toBeUndefined();
    expect(seenRequests.map((frame) => frame.kind)).toEqual([
      'stt_stream_start',
      'stt_stream_cancel',
    ]);
    expect(terminateCount).toBe(1);
    await client.stop();
  });

  it('rethrows worker error frames with the original voice-inference code', async () => {
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          reply({ kind: 'error', id: frame.id, code: 'runtime_unavailable', message: 'voice_inference_runtime_unavailable' });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });

    await expect(client.synthesizeTts({
      requestId: 'tts-err',
      text: 'hi',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await client.stop();
  });

  it('forwards D12 abort to the worker as a cancel frame', async () => {
    const abortTargets: string[] = [];
    let pendingReply: ((response: VoiceInferenceWorkerResponseFrame) => void) | null = null;
    let pendingId: string | null = null;
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          pendingReply = reply;
          pendingId = frame.id;
          return;
        }
        if (frame.kind === 'abort') {
          abortTargets.push(frame.targetId);
          // The worker reacts to cancel by finishing the targeted request with `cancelled`.
          pendingReply?.({ kind: 'error', id: frame.targetId, code: 'cancelled', message: 'voice_inference_cancelled' });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });

    const controller = new AbortController();
    const pending = client.synthesizeTts({
      requestId: 'tts-cancel',
      text: 'cancel me',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: controller.signal,
    });
    // Wait until the worker has the request, then abort.
    await vi.waitFor(() => expect(pendingId).not.toBeNull());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(abortTargets).toEqual([pendingId]);
    await client.stop();
  });

  it('rejects an already-aborted request locally without spawning the worker', async () => {
    const sentFrames: VoiceInferenceWorkerRequestFrame[] = [];
    let spawnCount = 0;
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        return createFakeChannel({
          onRequest: (frame) => {
            sentFrames.push(frame);
          },
        }).channel;
      },
    });
    const controller = new AbortController();
    controller.abort();

    const result = await Promise.race([
      client.synthesizeTts({
        requestId: 'tts-pre-aborted',
        text: 'cancelled',
        packId: 'pack-1',
        packDir: '/tmp/pack-1',
        manifest,
        voiceId: null,
        speed: null,
        output: { codec: 'wav', mimeType: 'audio/wav' },
        signal: controller.signal,
      }).catch((error) => error),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
    ]);

    expect(result).toMatchObject({ code: 'cancelled' });
    expect(spawnCount).toBe(0);
    expect(sentFrames).toEqual([]);
    await client.stop();
  });

  it('rejects and terminates when TTS partial indexes exceed the bounded sequence', async () => {
    vi.useFakeTimers();
    let terminateCount = 0;
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind !== 'synthesize') {
          return;
        }
        reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: 1_000_000, chunkBase64: Buffer.from('boom').toString('base64') });
        reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: '', name: 'bad.wav' } });
      },
    });
    const wrapped: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      terminate: () => {
        terminateCount += 1;
        fake.crash();
      },
    };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => wrapped,
      requestTimeoutMs: 1_000_000,
      pingIntervalMs: 0,
    });

    await expect(client.synthesizeTts({
      requestId: 'tts-high-index',
      text: 'bad',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({
      code: 'internal_error',
      message: 'voice_inference_worker_invalid_tts_partial',
    });
    expect(terminateCount).toBeGreaterThanOrEqual(1);
    await client.stop();
  });

  it('rejects and terminates when TTS partial chunks are non-contiguous or out of order', async () => {
    vi.useFakeTimers();
    let terminateCount = 0;
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind !== 'synthesize') {
          return;
        }
        reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: 0, chunkBase64: Buffer.from('a').toString('base64') });
        reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: 2, chunkBase64: Buffer.from('c').toString('base64') });
        reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: '', name: 'bad.wav' } });
      },
    });
    const wrapped: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      terminate: () => {
        terminateCount += 1;
        fake.crash();
      },
    };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => wrapped,
      requestTimeoutMs: 1_000_000,
      pingIntervalMs: 0,
    });

    await expect(client.synthesizeTts({
      requestId: 'tts-gap',
      text: 'bad',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({
      code: 'internal_error',
      message: 'voice_inference_worker_invalid_tts_partial',
    });
    expect(terminateCount).toBeGreaterThanOrEqual(1);
    await client.stop();
  });

  it('rejects in-flight requests cleanly when the worker crashes and never hangs', async () => {
    const fake = createFakeChannel({
      onRequest: (frame) => {
        // Never reply — simulate a hung/native-crashing engine.
        void frame;
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
    });

    const pending = client.transcribeAudio({
      requestId: 'stt-crash',
      filePath: '/tmp/upload.wav',
      inputMimeType: 'audio/wav',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: null,
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    });

    // Give the request a tick to be sent, then crash the worker.
    await Promise.resolve();
    fake.crash();

    await expect(pending).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await client.stop();
  });

  it('rejects the initiating request when the worker channel fails to spawn', async () => {
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        throw new Error('spawn failed');
      },
      policy: {
        kind: 'other',
        restart: { mode: 'never' },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 2_000,
      },
    });

    const request = client.synthesizeTts({
      requestId: 'tts-spawn-failure',
      text: 'hello',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    const outcome = await Promise.race([
      request.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);

    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: { code: 'runtime_unavailable' },
    });
    await client.stop();
  });

  it('restarts the worker with bounded backoff after an unexpected crash and serves the next request', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    const channelFactory = async () => {
      spawnCount += 1;
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (frame.kind === 'synthesize') {
            reply({
              kind: 'result',
              id: frame.id,
              result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: Buffer.from(`gen-${spawnCount}`).toString('base64'), name: 'r.wav' },
            });
          }
        },
      });
      if (spawnCount === 1) {
        // First worker crashes immediately after spawning.
        queueMicrotask(() => fake.crash());
      }
      return fake.channel;
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      random: () => 0,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    // Trigger the first spawn (will crash). Drain microtasks so the crash + restart schedule.
    const first = client.synthesizeTts({
      requestId: 'tts-1', text: 'a', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    await first;

    // Advance past the backoff delay so the supervisor respawns.
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnCount).toBeGreaterThanOrEqual(2);

    const second = await client.synthesizeTts({
      requestId: 'tts-2', text: 'b', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(second.bytes).toString('utf8')).toMatch(/^gen-/);
    await client.stop();
  });

  it('rejects a wedged-but-alive request with runtime_timeout and terminates the channel (H1a)', async () => {
    vi.useFakeTimers();
    let terminateCount = 0;
    const fake = createFakeChannel({
      onRequest: (frame) => {
        // Alive but wedged: the child never replies and never crashes.
        void frame;
      },
    });
    const wrapped: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      terminate: () => {
        terminateCount += 1;
        fake.channel.terminate();
      },
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => wrapped,
      requestTimeoutMs: 1_000,
      // Disable the heartbeat so the timeout is the sole reason the request settles.
      pingIntervalMs: 0,
    });

    const pending = client.synthesizeTts({
      requestId: 'tts-wedge', text: 'hi', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error) => error);

    // Let the request be sent, then advance past the per-request deadline.
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await pending;
    expect(error).toMatchObject({ code: 'runtime_timeout' });
    // The wedged child is marked unhealthy: the channel is terminated so the supervisor respawns.
    expect(terminateCount).toBeGreaterThanOrEqual(1);
    await client.stop();
  });

  it('does not time out a streaming request that keeps emitting chunks (H1 streaming keepalive)', async () => {
    vi.useFakeTimers();
    const captured: {
      reply: ((response: VoiceInferenceWorkerResponseFrame) => void) | null;
      id: string | null;
    } = { reply: null, id: null };
    const audio = Buffer.from('streamed-tts-payload');
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          captured.reply = reply;
          captured.id = frame.id;
        }
      },
    });

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
      requestTimeoutMs: 1_000,
      pingIntervalMs: 0,
    });

    const pending = client.synthesizeTts({
      requestId: 'tts-stream', text: 'long', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.advanceTimersByTimeAsync(1);
    const requestId = captured.id;
    const reply = captured.reply;
    if (requestId === null || reply === null) {
      throw new Error('expected the worker to have received the synthesize request');
    }

    // Emit a chunk every 800ms — under the 1s deadline. Activity must reset the timer, so the
    // request survives well past the original deadline (4 * 800ms = 3.2s > 1s).
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(800);
      reply({ kind: 'partial', id: requestId, partialKind: 'tts', index, chunkBase64: audio.subarray(index * 5, index * 5 + 5).toString('base64') });
    }
    // Now finish; the request must resolve, never having timed out.
    reply({ kind: 'result', id: requestId, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: '', name: 's.wav' } });

    const result = await pending;
    expect(Buffer.from(result.bytes)).toEqual(audio);
    await client.stop();
  });

  it('does not apply the idle heartbeat watchdog while a native request is in flight', async () => {
    vi.useFakeTimers();
    let terminateCount = 0;
    const captured: {
      reply: ((response: VoiceInferenceWorkerResponseFrame) => void) | null;
      id: string | null;
    } = { reply: null, id: null };
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          captured.id = frame.id;
          captured.reply = reply;
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => ({
        ...fake.channel,
        terminate: () => {
          terminateCount += 1;
          fake.crash();
        },
      }),
      requestTimeoutMs: 10_000,
      pingIntervalMs: 1_000,
      missedPingThreshold: 3,
    });

    const pending = client.synthesizeTts({
      requestId: 'tts-native-busy', text: 'busy', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.advanceTimersByTimeAsync(1);

    // Native warm/inference can monopolize the child event loop. The per-request deadline owns
    // that interval; the heartbeat is only an idle-channel watchdog and must not kill it early.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(terminateCount).toBe(0);

    const requestId = captured.id;
    const reply = captured.reply;
    if (requestId === null || reply === null) {
      throw new Error('expected the worker to receive the native request');
    }
    reply({ kind: 'result', id: requestId, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: '', name: 'busy.wav' } });
    await expect(pending).resolves.toMatchObject({ name: 'busy.wav' });
    await client.stop();
  });

  it('force-kills a hung-but-alive worker after N missed pings and reuses the supervised restart path (H1b)', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let terminateCount = 0;
    const channelFactory = async () => {
      spawnCount += 1;
      const generation = spawnCount;
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          // The first worker serves one request, then becomes idle-but-hung and stops answering
          // heartbeats. In-flight hangs are owned by the separate request deadline.
          if (generation === 1 && frame.kind === 'ping') {
            return;
          }
          if (frame.kind === 'ping') {
            reply({ kind: 'ready', id: frame.id });
            return;
          }
          if (frame.kind === 'synthesize') {
            reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: Buffer.from(`gen-${generation}`).toString('base64'), name: 'r.wav' } });
          }
        },
      });
      const wrapped: VoiceInferenceWorkerChannel = {
        ...fake.channel,
        terminate: () => {
          terminateCount += 1;
          // Terminating a real child resolves waitForTermination → the supervisor's restart path.
          fake.crash();
        },
      };
      return wrapped;
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      random: () => 0,
      requestTimeoutMs: 1_000_000, // large, so the watchdog (not the per-request timeout) is what fires
      pingIntervalMs: 1_000,
      missedPingThreshold: 3,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    // Start the first worker and prove it can serve work before becoming idle-but-hung.
    const first = client.synthesizeTts({
      requestId: 'tts-hung', text: 'a', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({ name: 'r.wav' });
    expect(spawnCount).toBe(1);

    // Advance through enough ping intervals with no pong → declared hung → force-kill.
    // (threshold=3 unanswered pings; the watchdog kills on the interval after the 3rd.)
    await vi.advanceTimersByTimeAsync(5_000);

    // The idle hung worker is force-killed through the existing supervisor.
    expect(terminateCount).toBeGreaterThanOrEqual(1);

    // The EXISTING supervised restart path respawns a healthy worker on the next use.
    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCount).toBeGreaterThanOrEqual(2);
    const second = await client.synthesizeTts({
      requestId: 'tts-ok', text: 'b', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(second.bytes).toString('utf8')).toMatch(/^gen-/);
    await client.stop();
  });

  it('terminates the channel and respawns when the child emits an undecodable oversized frame (M2a)', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let terminateCount = 0;
    const firstGen: { emitRaw: ((bytes: Buffer) => void) | null } = { emitRaw: null };
    const channelFactory = async () => {
      spawnCount += 1;
      const generation = spawnCount;
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (generation === 1) {
            return; // broken worker: never answers
          }
          if (frame.kind === 'synthesize') {
            reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: Buffer.from(`gen-${generation}`).toString('base64'), name: 'r.wav' } });
          }
        },
      });
      if (generation === 1) {
        firstGen.emitRaw = fake.emitRaw;
      }
      return {
        ...fake.channel,
        terminate: () => {
          terminateCount += 1;
          fake.crash();
        },
      };
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      random: () => 0,
      requestTimeoutMs: 1_000_000,
      pingIntervalMs: 0, // isolate the decode-error path from the watchdog
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const first = client.synthesizeTts({
      requestId: 'tts-decode', text: 'a', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnCount).toBe(1);

    // The child sends a length prefix beyond the per-frame ceiling. The decoder throws and can
    // never advance past it; the client must terminate (not swallow) so a clean child respawns.
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(0xffffffff, 0);
    firstGen.emitRaw?.(oversized);
    await vi.advanceTimersByTimeAsync(1);

    expect(terminateCount).toBeGreaterThanOrEqual(1);
    const firstError = await first;
    expect(firstError).toMatchObject({ code: 'runtime_unavailable' });

    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCount).toBeGreaterThanOrEqual(2);
    const second = await client.synthesizeTts({
      requestId: 'tts-ok', text: 'b', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(second.bytes).toString('utf8')).toMatch(/^gen-/);
    await client.stop();
  });

  it('does not let undecodable dribble from the child starve the liveness watchdog (M2b)', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let terminateCount = 0;
    const firstGen: { emitRaw: ((bytes: Buffer) => void) | null } = { emitRaw: null };
    const channelFactory = async () => {
      spawnCount += 1;
      const generation = spawnCount;
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (generation === 1 && frame.kind === 'ping') {
            return; // idle-but-broken worker: answers the admission request, then no pings
          }
          if (frame.kind === 'ping') {
            reply({ kind: 'ready', id: frame.id });
            return;
          }
          if (frame.kind === 'synthesize') {
            reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: Buffer.from(`gen-${generation}`).toString('base64'), name: 'r.wav' } });
          }
        },
      });
      if (generation === 1) {
        firstGen.emitRaw = fake.emitRaw;
      }
      return {
        ...fake.channel,
        terminate: () => {
          terminateCount += 1;
          fake.crash();
        },
      };
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      random: () => 0,
      requestTimeoutMs: 1_000_000, // large, so the watchdog (not the per-request deadline) is what fires
      pingIntervalMs: 1_000,
      missedPingThreshold: 3,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const first = client.synthesizeTts({
      requestId: 'tts-dribble', text: 'a', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({ name: 'r.wav' });
    expect(spawnCount).toBe(1);

    // The broken child is CHATTY: each ping interval it dribbles a lone 4-byte length prefix whose
    // payload never arrives. These bytes buffer in the decoder (no complete frame, no throw). They
    // must NOT reset the missed-ping counter — only a fully decoded, valid frame may.
    const dribblePrefix = Buffer.alloc(4);
    dribblePrefix.writeUInt32BE(64, 0);
    for (let i = 0; i < 4; i += 1) {
      firstGen.emitRaw?.(Buffer.from(dribblePrefix));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(1);

    // The watchdog still trips despite the chatter → force-kill → supervised respawn.
    expect(terminateCount).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCount).toBeGreaterThanOrEqual(2);
    const second = await client.synthesizeTts({
      requestId: 'tts-ok', text: 'b', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(second.bytes).toString('utf8')).toMatch(/^gen-/);
    await client.stop();
  });

  it('terminates and respawns when the child sends a decodable but schema-invalid frame (L4)', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let terminateCount = 0;
    const channelFactory = async () => {
      spawnCount += 1;
      const generation = spawnCount;
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (frame.kind !== 'synthesize') {
            return;
          }
          if (generation === 1) {
            // Well-framed, valid JSON, but the tts partial carries an illegal negative index used
            // directly as a chunk array key. It decodes cleanly yet must be REJECTED → terminate.
            reply({ kind: 'partial', id: frame.id, partialKind: 'tts', index: -1, chunkBase64: 'AAA=' });
            return;
          }
          reply({ kind: 'result', id: frame.id, result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: Buffer.from(`gen-${generation}`).toString('base64'), name: 'r.wav' } });
        },
      });
      return {
        ...fake.channel,
        terminate: () => {
          terminateCount += 1;
          fake.crash();
        },
      };
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory,
      random: () => 0,
      requestTimeoutMs: 1_000_000,
      pingIntervalMs: 0,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 100, maxDelayMs: 1_000, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const first = client.synthesizeTts({
      requestId: 'tts-malformed', text: 'a', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);

    expect(terminateCount).toBeGreaterThanOrEqual(1);
    const firstError = await first;
    expect(firstError).toMatchObject({ code: 'runtime_unavailable' });

    await vi.advanceTimersByTimeAsync(300);
    expect(spawnCount).toBeGreaterThanOrEqual(2);
    const second = await client.synthesizeTts({
      requestId: 'tts-ok', text: 'b', packId: 'pack-1', packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null, output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(Buffer.from(second.bytes).toString('utf8')).toMatch(/^gen-/);
    await client.stop();
  });

  it('terminates the worker on stop with no leaked process', async () => {
    let terminated = false;
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'warm') {
          reply({ kind: 'result', id: frame.id, result: { kind: 'warm' } });
        }
      },
    });
    const wrappedChannel: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      terminate: () => {
        terminated = true;
        fake.channel.terminate();
      },
    };
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => wrappedChannel });
    // Force a spawn. `warmModel` is optional on the engine interface but always present on the
    // forked client, so optional-chaining keeps this type-safe without changing intent.
    await client.warmModel?.({ packId: 'pack-1', packDir: '/tmp/pack-1', manifest });
    await client.stop();
    expect(terminated).toBe(true);
  });
});
