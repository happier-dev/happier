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
    forceTerminate: () => resolveTermination({ type: 'signaled', signal: 'SIGKILL' }),
  };

  return {
    channel,
    reply,
    /** Push arbitrary raw bytes to the client's data path (corrupt/undecodable wire noise). */
    emitRaw: (bytes: Buffer) => dataListener?.(bytes),
    crash: () => resolveTermination({ type: 'exited', code: 139 }),
  };
}

function invokeWarmOrPrime(
  client: ReturnType<typeof createForkedVoiceInferenceRuntimeClient>,
  kind: 'warm' | 'prime',
  signal?: AbortSignal,
): Promise<void> {
  if (kind === 'warm') {
    if (!client.warmModel) {
      throw new Error('expected forked runtime warmModel');
    }
    return client.warmModel({
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      signal,
    });
  }
  if (!client.primeModel) {
    throw new Error('expected forked runtime primeModel');
  }
  return client.primeModel({
    packId: 'pack-1',
    packDir: '/tmp/pack-1',
    manifest,
    signal,
  });
}

describe('forked voice inference runtime client', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('proxies a terminal direct TTS result over IPC', async () => {
    const audio = Buffer.from('forked-tts-audio');
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          reply({
            kind: 'result',
            id: frame.id,
            result: { kind: 'synthesize', output: { codec: 'wav', mimeType: 'audio/wav' }, bytesBase64: audio.toString('base64'), name: 'forked.wav' },
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

  it('preserves an output-bound terminal error without retiring a healthy worker', async () => {
    let synthesizeCount = 0;
    const fake = createFakeChannel({
      onRequest: (frame, reply) => {
        if (frame.kind === 'synthesize') {
          synthesizeCount += 1;
          if (synthesizeCount === 1) {
            reply({
              kind: 'error',
              id: frame.id,
              code: 'output_too_large',
              message: 'voice_inference_tts_output_too_large',
            });
            return;
          }
          reply({
            kind: 'result',
            id: frame.id,
            result: {
              kind: 'synthesize',
              output: { codec: 'wav', mimeType: 'audio/wav' },
              bytesBase64: Buffer.from('healthy-successor').toString('base64'),
              name: 'healthy.wav',
            },
          });
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
    });

    await expect(client.synthesizeTts({
      requestId: 'tts-too-large',
      text: 'long output',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).rejects.toMatchObject({ code: 'output_too_large' });

    await expect(client.synthesizeTts({
      requestId: 'tts-after-bound-error',
      text: 'short output',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).resolves.toMatchObject({ name: 'healthy.wav' });
    expect(synthesizeCount).toBe(2);
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

  it.each(['append', 'finish'] as const)(
    'lets cancellation win over a decoded late streaming %s result',
    async (operation) => {
      const pendingOperation: {
        id: string | null;
        reply: ((response: VoiceInferenceWorkerResponseFrame) => void) | null;
      } = { id: null, reply: null };
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (frame.kind === 'stt_stream_start') {
            reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_start', sessionId: 'worker-stream-late-operation' } });
            return;
          }
          if (frame.kind === 'stt_stream_append' || frame.kind === 'stt_stream_finish') {
            pendingOperation.id = frame.id;
            pendingOperation.reply = reply;
            return;
          }
          if (frame.kind === 'stt_stream_cancel') {
            reply({ kind: 'result', id: frame.id, result: { kind: 'stt_stream_cancel' } });
          }
        },
      });
      const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });

      try {
        const session = await client.createStreamingTranscriptionSession?.({
          requestId: `stt-stream-late-${operation}`,
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
        if (!session) {
          throw new Error('expected forked streaming session');
        }
        const controller = new AbortController();
        const pending = operation === 'append'
          ? session.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0]), signal: controller.signal })
          : session.finish({ finalSeq: 0, signal: controller.signal });
        await vi.waitFor(() => expect(pendingOperation.id).not.toBeNull());
        const reply = pendingOperation.reply;
        const id = pendingOperation.id;
        if (!reply || !id) {
          throw new Error('expected a pending streaming operation');
        }

        reply(operation === 'append'
          ? { kind: 'result', id, result: { kind: 'stt_stream_append', events: [] } }
          : { kind: 'result', id, result: { kind: 'stt_stream_finish', text: 'late', language: 'en', events: [] } });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
        if (operation === 'append') {
          await session.close();
        }
      } finally {
        await client.stop();
      }
    },
  );

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

  it('settles an executing TTS abort locally and terminates an unresponsive native worker', async () => {
    const abortTargets: string[] = [];
    let pendingId: string | null = null;
    let terminateCount = 0;
    const fake = createFakeChannel({
      onRequest: (frame) => {
        if (frame.kind === 'synthesize') {
          // Model the real synchronous native engine: the request is executing, but the child
          // event loop cannot consume the abort frame or emit a terminal response.
          pendingId = frame.id;
          return;
        }
        if (frame.kind === 'abort') {
          abortTargets.push(frame.targetId);
        }
      },
    });
    const channel: VoiceInferenceWorkerChannel = {
      ...fake.channel,
      forceTerminate: () => {
        terminateCount += 1;
        fake.channel.forceTerminate();
      },
    };
    const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => channel });

    const controller = new AbortController();
    const pending = client.synthesizeTts({
      requestId: 'tts-native-active-cancel',
      text: 'cancel active native synthesis',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(pendingId).not.toBeNull());
    controller.abort();

    const outcome = await Promise.race([
      pending.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);
    expect(outcome).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
    expect(abortTargets).toEqual([pendingId]);
    expect(terminateCount).toBe(1);
    await client.stop();
  });

  it.each(['warm', 'prime'] as const)(
    'lets cancellation win over a decoded late native %s result',
    async (kind) => {
      const pendingOperation: {
        id: string | null;
        reply: ((response: VoiceInferenceWorkerResponseFrame) => void) | null;
      } = { id: null, reply: null };
      const fake = createFakeChannel({
        onRequest: (frame, reply) => {
          if (frame.kind === kind) {
            pendingOperation.id = frame.id;
            pendingOperation.reply = reply;
          }
        },
      });
      const client = createForkedVoiceInferenceRuntimeClient({ channelFactory: async () => fake.channel });
      const controller = new AbortController();

      try {
        const pending = invokeWarmOrPrime(client, kind, controller.signal);
        await vi.waitFor(() => expect(pendingOperation.id).not.toBeNull());
        const reply = pendingOperation.reply;
        const id = pendingOperation.id;
        if (!reply || !id) {
          throw new Error('expected a pending warm or prime operation');
        }

        reply({ kind: 'result', id, result: kind === 'warm' ? { kind: 'warm' } : { kind: 'prime' } });
        controller.abort();

        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      } finally {
        await client.stop();
      }
    },
  );

  it.each(['warm', 'prime'] as const)(
    'settles an aborted native %s locally, retires its exact channel, and waits for the supervised replacement',
    async (kind) => {
      let spawnCount = 0;
      let forceTerminateCount = 0;
      let firstRequestId: string | null = null;
      let staleSuccessorCount = 0;
      const abortTargets: string[] = [];
      const firstFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };
      const client = createForkedVoiceInferenceRuntimeClient({
        channelFactory: async () => {
          spawnCount += 1;
          const generation = spawnCount;
          const fake = createFakeChannel({
            pid: 4_250 + generation,
            onRequest: (frame, reply) => {
              if (frame.kind === 'abort') {
                abortTargets.push(frame.targetId);
                return;
              }
              if (frame.kind !== kind) {
                return;
              }
              if (generation === 1 && firstRequestId === null) {
                // Model a synchronous native warm/prime: its child event loop cannot consume
                // the cooperative abort frame or send a terminal response until it returns.
                firstRequestId = frame.id;
                return;
              }
              if (generation === 1) {
                staleSuccessorCount += 1;
                return;
              }
              reply({
                kind: 'result',
                id: frame.id,
                result: kind === 'warm' ? { kind: 'warm' } : { kind: 'prime' },
              });
            },
          });
          if (generation === 1) {
            firstFakeRef.value = fake;
            return {
              ...fake.channel,
              forceTerminate: () => {
                forceTerminateCount += 1;
                // OS termination is asynchronous: prove a buffered late result cannot win
                // before this exact child reports its own exit.
              },
            };
          }
          return fake.channel;
        },
        random: () => 0,
        policy: {
          kind: 'other',
          restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
          logging: { logTerminationEvents: false },
          artifacts: { captureStderr: false },
          terminateGraceMs: 0,
        },
      });

      try {
        const controller = new AbortController();
        const cancelled = invokeWarmOrPrime(client, kind, controller.signal);
        await vi.waitFor(() => expect(firstRequestId).not.toBeNull());
        controller.abort();

        const cancellationOutcome = await Promise.race([
          cancelled.then(
            () => ({ kind: 'resolved' as const }),
            (error: unknown) => ({ kind: 'rejected' as const, error }),
          ),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            setTimeout(() => resolve({ kind: 'timeout' }), 100);
          }),
        ]);
        expect(cancellationOutcome).toMatchObject({
          kind: 'rejected',
          error: { code: 'cancelled' },
        });
        expect(forceTerminateCount).toBe(1);
        expect(abortTargets).toEqual([firstRequestId]);

        const successor = invokeWarmOrPrime(client, kind);
        const retiringFake = firstFakeRef.value;
        if (!retiringFake || firstRequestId === null) {
          throw new Error('expected the first worker to own the aborted warm/prime request');
        }
        retiringFake.reply({
          kind: 'result',
          id: firstRequestId,
          result: kind === 'warm' ? { kind: 'warm' } : { kind: 'prime' },
        });
        expect(spawnCount).toBe(1);
        expect(staleSuccessorCount).toBe(0);

        retiringFake.crash();
        await expect(successor).resolves.toBeUndefined();
        expect(spawnCount).toBe(2);
      } finally {
        await client.stop();
      }
    },
  );

  it('routes an immediate retry to the replacement while the cancelled TTS worker is still terminating', async () => {
    let spawnCount = 0;
    let forceTerminateCount = 0;
    let cancelledRequestId: string | null = null;
    let staleRetryCount = 0;
    const firstFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        const generation = spawnCount;
        const fake = createFakeChannel({
          pid: 4_200 + generation,
          onRequest: (frame, reply) => {
            if (frame.kind !== 'synthesize') {
              return;
            }
            if (generation === 1 && cancelledRequestId === null) {
              cancelledRequestId = frame.id;
              return;
            }
            if (generation === 1) {
              staleRetryCount += 1;
              reply({
                kind: 'error',
                id: frame.id,
                code: 'runtime_unavailable',
                message: 'retiring_worker_rejected_retry',
              });
              return;
            }
            reply({
              kind: 'result',
              id: frame.id,
              result: {
                kind: 'synthesize',
                output: { codec: 'wav', mimeType: 'audio/wav' },
                bytesBase64: Buffer.from(`replacement-${generation}`).toString('base64'),
                name: 'replacement.wav',
              },
            });
          },
        });
        if (generation === 1) {
          firstFakeRef.value = fake;
          return {
            ...fake.channel,
            forceTerminate: () => {
              forceTerminateCount += 1;
              // Model asynchronous OS termination: cancellation settles before waitForTermination.
            },
          };
        }
        return fake.channel;
      },
      random: () => 0,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const controller = new AbortController();
    const cancelled = client.synthesizeTts({
      requestId: 'tts-cancel-before-immediate-retry',
      text: 'cancel active native synthesis',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(cancelledRequestId).not.toBeNull());
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

    const retry = client.synthesizeTts({
      requestId: 'tts-immediate-retry',
      text: 'route me to the replacement',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    const retiringFake = firstFakeRef.value;
    if (!retiringFake || cancelledRequestId === null) {
      throw new Error('expected the first worker to own the cancelled request');
    }
    // A late result from the doomed child must remain inert. Its eventual exit is what gives the
    // existing sequential supervisor authority to create the replacement.
    retiringFake.reply({
      kind: 'result',
      id: cancelledRequestId,
      result: {
        kind: 'synthesize',
        output: { codec: 'wav', mimeType: 'audio/wav' },
        bytesBase64: Buffer.from('stale-cancelled-output').toString('base64'),
        name: 'stale.wav',
      },
    });
    expect(spawnCount).toBe(1);
    retiringFake.crash();

    await expect(retry).resolves.toMatchObject({ name: 'replacement.wav' });
    expect(forceTerminateCount).toBe(1);
    expect(staleRetryCount).toBe(0);
    expect(spawnCount).toBe(2);
    await client.stop();
  });

  it('retires an aborted STT worker before stale output and admits a successor only after its exact replacement', async () => {
    let spawnCount = 0;
    let forceTerminateCount = 0;
    let cancelledRequestId: string | null = null;
    let staleSuccessorCount = 0;
    const firstFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        const generation = spawnCount;
        const fake = createFakeChannel({
          pid: 4_300 + generation,
          onRequest: (frame, reply) => {
            if (frame.kind !== 'transcribe') {
              return;
            }
            if (generation === 1 && cancelledRequestId === null) {
              cancelledRequestId = frame.id;
              return;
            }
            if (generation === 1) {
              staleSuccessorCount += 1;
              return;
            }
            reply({
              kind: 'result',
              id: frame.id,
              result: { kind: 'transcribe', text: 'replacement transcription', language: 'en' },
            });
          },
        });
        if (generation === 1) {
          firstFakeRef.value = fake;
          return {
            ...fake.channel,
            forceTerminate: () => {
              forceTerminateCount += 1;
              // Model asynchronous OS termination: stale output can arrive before the exact child exits.
            },
          };
        }
        return fake.channel;
      },
      random: () => 0,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const controller = new AbortController();
    const cancelled = client.transcribeAudio({
      requestId: 'stt-cancel-before-successor',
      filePath: '/tmp/cancelled.wav',
      inputMimeType: 'audio/wav',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: 'en',
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(cancelledRequestId).not.toBeNull());
    controller.abort();

    const cancellationOutcome = await Promise.race([
      cancelled.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);
    expect(cancellationOutcome).toMatchObject({
      kind: 'rejected',
      error: { code: 'cancelled' },
    });
    expect(forceTerminateCount).toBe(1);

    const successor = client.transcribeAudio({
      requestId: 'stt-successor-after-cancel',
      filePath: '/tmp/successor.wav',
      inputMimeType: 'audio/wav',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      language: 'en',
      normalization: { inputTransport: 'upload_transfer', strategy: 'daemon_decode', systemFfmpegAllowed: false },
    });

    const retiringFake = firstFakeRef.value;
    if (!retiringFake || cancelledRequestId === null) {
      throw new Error('expected the first worker to own the cancelled transcription');
    }
    retiringFake.reply({
      kind: 'result',
      id: cancelledRequestId,
      result: { kind: 'transcribe', text: 'stale transcription', language: 'en' },
    });
    expect(spawnCount).toBe(1);
    expect(staleSuccessorCount).toBe(0);
    retiringFake.crash();

    await expect(successor).resolves.toEqual({ text: 'replacement transcription', language: 'en' });
    expect(spawnCount).toBe(2);
    await client.stop();
  });

  it('rejects replacement waiters and awaits the retiring child when stopped during cancellation', async () => {
    let cancelledRequestId: string | null = null;
    let spawnCount = 0;
    const retiringFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        const fake = createFakeChannel({
          onRequest: (frame) => {
            if (frame.kind === 'synthesize') {
              cancelledRequestId = frame.id;
            }
          },
        });
        retiringFakeRef.value = fake;
        return {
          ...fake.channel,
          forceTerminate: () => {
            // Keep OS termination pending until the test releases the exact child below.
          },
          terminate: () => {
            // stop() must await waitForTermination rather than treating retired as already gone.
          },
        };
      },
    });

    const controller = new AbortController();
    const cancelled = client.synthesizeTts({
      requestId: 'tts-cancel-before-stop',
      text: 'cancel before daemon stop',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(cancelledRequestId).not.toBeNull());
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

    const replacementWaiter = client.synthesizeTts({
      requestId: 'tts-waiting-for-replacement-at-stop',
      text: 'must not outlive stop',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    const stopPromise = client.stop();

    await expect(replacementWaiter).rejects.toMatchObject({ code: 'runtime_unavailable' });
    await expect(Promise.race([
      stopPromise.then(() => 'stopped' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
    ])).resolves.toBe('pending');

    const stoppedFake = retiringFakeRef.value;
    if (!stoppedFake) {
      throw new Error('expected a retiring worker channel');
    }
    stoppedFake.crash();
    await expect(stopPromise).resolves.toBeUndefined();
    expect(spawnCount).toBe(1);
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
      forceTerminate: () => {
        terminateCount += 1;
        fake.channel.forceTerminate();
      },
    };

    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => wrapped,
      requestTimeoutMs: 1_000,
      warmPrimeRequestTimeoutMs: 1_000,
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

  it('uses the measured native-operation deadline for synchronous synthesis', async () => {
    vi.useFakeTimers();
    const fake = createFakeChannel({ onRequest: () => {} });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => fake.channel,
      requestTimeoutMs: 1_000,
      warmPrimeRequestTimeoutMs: 5_000,
    });
    const pending = client.synthesizeTts({
      requestId: 'tts-native-budget', text: 'healthy native work', packId: 'pack-1',
      packDir: '/tmp/pack-1', manifest, voiceId: null, speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error) => error);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await expect(pending).resolves.toMatchObject({ code: 'runtime_timeout' });
    await client.stop();
  });

  it('retires the exact warmed child when its prime request times out', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let forceTerminateCount = 0;
    let firstPrimeRequestId: string | null = null;
    const firstFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        const generation = spawnCount;
        const fake = createFakeChannel({
          onRequest: (frame, reply) => {
            if (frame.kind === 'warm') {
              reply({ kind: 'result', id: frame.id, result: { kind: 'warm' } });
              return;
            }
            if (frame.kind === 'prime' && generation === 1) {
              firstPrimeRequestId = frame.id;
              return;
            }
            if (frame.kind === 'prime') {
              reply({ kind: 'result', id: frame.id, result: { kind: 'prime' } });
            }
          },
        });
        if (generation === 1) {
          firstFakeRef.value = fake;
          return {
            ...fake.channel,
            forceTerminate: () => {
              forceTerminateCount += 1;
              // Model asynchronous OS termination: buffered frames from this exact child remain
              // possible until its own termination event reaches the sole supervisor.
            },
          };
        }
        return fake.channel;
      },
      random: () => 0,
      requestTimeoutMs: 1_000,
      warmPrimeRequestTimeoutMs: 1_000,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    try {
      await invokeWarmOrPrime(client, 'warm');
      const timedOut = invokeWarmOrPrime(client, 'prime').catch((error: unknown) => error);
      // Let the async channel admission put the request on the wire before advancing its
      // operation-specific deadline. Advancing fake time before `send()` would move the clock
      // first and arm the timeout at the new instant.
      for (let index = 0; index < 8 && firstPrimeRequestId === null; index += 1) {
        await Promise.resolve();
      }
      expect(firstPrimeRequestId).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(timedOut).resolves.toMatchObject({ code: 'runtime_timeout' });
      expect(forceTerminateCount).toBe(1);
      expect(spawnCount).toBe(1);

      const firstFake = firstFakeRef.value;
      if (!firstFake || firstPrimeRequestId === null) {
        throw new Error('expected the warmed first child to own the timed-out prime request');
      }
      firstFake.reply({ kind: 'result', id: firstPrimeRequestId, result: { kind: 'prime' } });
      expect(spawnCount).toBe(1);

      const successor = invokeWarmOrPrime(client, 'prime');
      firstFake.crash();
      await vi.advanceTimersByTimeAsync(1);
      await expect(successor).resolves.toBeUndefined();
      expect(spawnCount).toBe(2);
    } finally {
      await client.stop();
    }
  });

  it('ignores late snapshots and results from a timed-out channel for its other concurrent requests', async () => {
    vi.useFakeTimers();
    const requestIdsByCaller = new Map<string, string>();
    const snapshots: string[] = [];
    const fake = createFakeChannel({
      onRequest: (frame) => {
        if (frame.kind === 'synthesize') {
          requestIdsByCaller.set(frame.requestId, frame.id);
        }
      },
    });
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => ({
        ...fake.channel,
        forceTerminate: () => {
          // Model asynchronous OS termination: the retiring child can still emit buffered frames
          // before waitForTermination settles.
        },
      }),
      requestTimeoutMs: 1_000,
      warmPrimeRequestTimeoutMs: 1_000,
      onSnapshot: (snapshot) => snapshots.push(`${snapshot.packId}:${snapshot.runtimeState}`),
      policy: {
        kind: 'other',
        restart: { mode: 'never' },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const timedOutOutcome = client.synthesizeTts({
      requestId: 'tts-concurrent-timeout-a',
      text: 'time out first',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    }).then(
      (result) => ({ kind: 'resolved' as const, result }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(500);

    const concurrentOutcome = client.synthesizeTts({
      requestId: 'tts-concurrent-pending-b',
      text: 'remain pending on the same child',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    }).then(
      (result) => ({ kind: 'resolved' as const, result }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(timedOutOutcome).resolves.toMatchObject({
      kind: 'rejected',
      error: { code: 'runtime_timeout' },
    });
    const concurrentId = requestIdsByCaller.get('tts-concurrent-pending-b');
    if (!concurrentId) {
      throw new Error('expected the concurrent request to be admitted to the first worker');
    }

    fake.reply({ kind: 'snapshot', packId: 'pack-1', runtimeState: 'ready' });
    fake.reply({
      kind: 'result',
      id: concurrentId,
      result: {
        kind: 'synthesize',
        output: { codec: 'wav', mimeType: 'audio/wav' },
        bytesBase64: Buffer.from('late-old').toString('base64'),
        name: 'late-old.wav',
      },
    });
    fake.crash();

    await expect(concurrentOutcome).resolves.toMatchObject({
      kind: 'rejected',
      error: { code: 'runtime_unavailable' },
    });
    expect(snapshots).toEqual([]);
    await client.stop();
  });

  it('waits for the supervised replacement instead of sending an immediate successor to a timed-out worker', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    let forceTerminateCount = 0;
    let staleSuccessorCount = 0;
    const firstFakeRef: { value: ReturnType<typeof createFakeChannel> | null } = { value: null };
    const client = createForkedVoiceInferenceRuntimeClient({
      channelFactory: async () => {
        spawnCount += 1;
        const generation = spawnCount;
        const fake = createFakeChannel({
          pid: 5_100 + generation,
          onRequest: (frame, reply) => {
            if (frame.kind !== 'synthesize') {
              return;
            }
            if (generation === 1 && frame.requestId === 'tts-timeout-successor') {
              staleSuccessorCount += 1;
              return;
            }
            if (generation > 1) {
              reply({
                kind: 'result',
                id: frame.id,
                result: {
                  kind: 'synthesize',
                  output: { codec: 'wav', mimeType: 'audio/wav' },
                  bytesBase64: Buffer.from(`replacement-${generation}`).toString('base64'),
                  name: 'replacement.wav',
                },
              });
            }
          },
        });
        if (generation === 1) {
          firstFakeRef.value = fake;
          return {
            ...fake.channel,
            forceTerminate: () => {
              forceTerminateCount += 1;
              // Model asynchronous OS termination: the timeout settles before child exit.
            },
          };
        }
        return fake.channel;
      },
      random: () => 0,
      requestTimeoutMs: 1_000,
      warmPrimeRequestTimeoutMs: 1_000,
      policy: {
        kind: 'other',
        restart: { mode: 'on_unexpected_exit', maxRestarts: null, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0 },
        logging: { logTerminationEvents: false },
        artifacts: { captureStderr: false },
        terminateGraceMs: 0,
      },
    });

    const timedOut = client.synthesizeTts({
      requestId: 'tts-timeout-retiring',
      text: 'time out this worker',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toMatchObject({ code: 'runtime_timeout' });

    const successor = client.synthesizeTts({
      requestId: 'tts-timeout-successor',
      text: 'wait for the replacement',
      packId: 'pack-1',
      packDir: '/tmp/pack-1',
      manifest,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(forceTerminateCount).toBe(1);
    expect(staleSuccessorCount).toBe(0);
    expect(spawnCount).toBe(1);

    const firstFake = firstFakeRef.value;
    if (!firstFake) {
      throw new Error('expected the timed-out worker channel');
    }
    firstFake.crash();
    await vi.advanceTimersByTimeAsync(1);

    await expect(successor).resolves.toMatchObject({ name: 'replacement.wav' });
    expect(spawnCount).toBe(2);
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
            // Well-framed, valid JSON, but the terminal output descriptor is invalid. It decodes
            // cleanly yet must be REJECTED → terminate.
            reply({
              kind: 'result',
              id: frame.id,
              result: {
                kind: 'synthesize',
                output: { codec: 'wav', mimeType: 'audio/mpeg' },
                bytesBase64: 'AAA=',
                name: 'invalid.wav',
              },
            } as unknown as VoiceInferenceWorkerResponseFrame);
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
