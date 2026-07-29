import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  createSpeechTranscriptionApplicationAuthorityDigestV1,
  DaemonVoiceInferenceSttStreamChunkRequestSchema,
  type DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';

import { registerMachineVoiceInferenceStreamingRpcHandlers } from './rpcHandlers.voiceInferenceStreaming';

type Handler = (data: any) => Promise<any>;
type BinaryAppendConsumer = (input: Readonly<{
  streamId: string;
  generation: number;
  seq: number;
  pcm16Bytes: Uint8Array;
}>) => Promise<Readonly<{
  ok: boolean;
  streamId?: string;
  generation?: number;
  ackSeq?: number;
  events?: readonly unknown[];
  errorCode?: string;
}>>;
type BinaryTerminalConsumer = (input: Readonly<{
  streamId?: string;
  generation?: number;
  voiceMediaApplicationAuthority: Readonly<{
    v: 1;
    applicationKind: 'speech_transcription';
    applicationAttemptId: string;
    applicationAuthorityDigest: string;
  }>;
}>) => Promise<Readonly<{ ok: boolean; errorCode?: string }>>;

type RuntimeStreamSession = Readonly<{
  appendPcm16: (input: Readonly<{ seq: number; pcm16Bytes: Uint8Array; signal?: AbortSignal | null }>) => Promise<Readonly<{
    events: readonly unknown[];
  }>>;
  finish: (input: Readonly<{ finalSeq: number; signal?: AbortSignal | null }>) => Promise<Readonly<{
    text: string;
    language: string | null;
    events: readonly unknown[];
  }>>;
  cancel: () => Promise<void>;
  close: () => Promise<void>;
}>;

const originalSttMaxUploadBytes = process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalSttMaxUploadBytes === undefined) {
    delete process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
  } else {
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = originalSttMaxUploadBytes;
  }
});

describe('registerMachineVoiceInferenceStreamingRpcHandlers', () => {
  it('cancels the exact authority-bound stream once when its peer transport is lost', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const cancelStt = vi.fn(async () => {});
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      } as any,
    }) as unknown as { cancelSttStreamForTransportLoss: BinaryTerminalConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-request';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId: null,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: {
        ...authority,
        applicationAttemptId: 'another-request',
        applicationAuthorityDigest:
          createSpeechTranscriptionApplicationAuthorityDigestV1('another-request'),
      },
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true, state: 'open' });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: true });
    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: started.streamId,
      generation: started.generation,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('cancels the authority-bound stream when transport is lost before its first carrier frame', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const cancelStt = vi.fn(async () => {});
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      } as any,
    }) as unknown as { cancelSttStreamForTransportLoss: BinaryTerminalConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-before-first-frame';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId: null,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    const lossResult = await registration.cancelSttStreamForTransportLoss({
      voiceMediaApplicationAuthority: authority,
    });
    if (!lossResult.ok) {
      await registration.cancelSttStreamForTransportLoss({
        streamId: started.streamId,
        generation: started.generation,
        voiceMediaApplicationAuthority: authority,
      });
    }
    expect(lossResult).toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('binds transport-loss cleanup to signed application authority instead of forged carrier identity', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const cancelStt = vi.fn(async () => {});
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      } as any,
    }) as unknown as { cancelSttStreamForTransportLoss: BinaryTerminalConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
    const requestId = 'transport-loss-forged-carrier';
    const authority = {
      v: 1 as const,
      applicationKind: 'speech_transcription' as const,
      applicationAttemptId: requestId,
      applicationAuthorityDigest: createSpeechTranscriptionApplicationAuthorityDigestV1(requestId),
    };
    const started = await sttStreamStart?.({
      requestId,
      packId: null,
      language: null,
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, generation: 0 });

    await expect(registration.cancelSttStreamForTransportLoss({
      streamId: 'forged-carrier-stream',
      generation: started.generation + 1,
      voiceMediaApplicationAuthority: authority,
    })).resolves.toMatchObject({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledOnce();
  });

  it('streams daemon STT PCM chunks into a canonical wav file and transcribes through the worker on finish', async () => {
    let observedInput: null | Readonly<{
      requestId: string;
      uploadId: string;
      filePath: string;
      inputMimeType: string;
      packId: string | null;
      language: string | null;
      normalization: DaemonVoiceInferenceNormalizationDecision;
    }> = null;
    const transcribeAudio = vi.fn(async (input: NonNullable<typeof observedInput>) => {
      observedInput = input;
      const wav = readFileSync(input.filePath);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(16_000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
      expect(wav.readUInt32LE(40)).toBe(4);
      expect(wav.subarray(44).equals(Buffer.from([0, 0, 1, 0]))).toBe(true);
      return {
        requestId: input.requestId,
        text: 'streamed daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
      } as any,
    });

    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CHUNK);
    const sttStreamFinish = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-1',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toEqual(expect.objectContaining({
      ok: true,
      requestId: 'stream-request-1',
      streamId: expect.any(String),
      generation: 0,
      ackSeq: -1,
    }));
    await expect(sttStreamChunk?.({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Base64: Buffer.from([0, 0, 1, 0]).toString('base64'),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      state: 'open',
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'streamed daemon transcript',
      language: 'en',
      modelPackId: 'stt-pack-1',
      events: [{ type: 'final', seq: 0, text: 'streamed daemon transcript', language: 'en', modelPackId: 'stt-pack-1' }],
    });
    expect(observedInput).toMatchObject({
      requestId: 'stream-request-1',
      uploadId: started.streamId,
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-1',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
      },
    });
  });

  it('accepts raw PCM16 bytes through the binary append consumer without parsing the compatibility chunk schema', async () => {
    const transcribeAudio = vi.fn(async (input: { filePath: string; requestId: string; language: string | null; packId: string | null }) => {
      const wav = readFileSync(input.filePath);
      expect(wav.readUInt32LE(40)).toBe(4);
      expect([...wav.subarray(44)]).toEqual([0, 0, 1, 0]);
      return {
        requestId: input.requestId,
        text: 'binary daemon transcript',
        language: input.language,
        modelPackId: input.packId,
      };
    });
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
      } as any,
    }) as unknown as { appendSttStreamBinaryFrame: BinaryAppendConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);
    const safeParseSpy = vi.spyOn(DaemonVoiceInferenceSttStreamChunkRequestSchema, 'safeParse');

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });
    safeParseSpy.mockClear();

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });
    expect(safeParseSpy).not.toHaveBeenCalled();

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
    });
    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toMatchObject({
      ok: true,
      ackSeq: 0,
      finalText: 'binary daemon transcript',
    });
  });

  it('emits runtime streaming partial and endpoint events before finish and final events on finish', async () => {
    const runtimeEvents: unknown[][] = [];
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async (input) => {
        expect(input.seq).toBe(0);
        expect([...input.pcm16Bytes]).toEqual([0, 0, 1, 0]);
        const events = [
          { type: 'partial', seq: input.seq, text: 'hel', isEndpoint: false, confidence: null },
          { type: 'endpoint', seq: input.seq, transcript: 'hello', reason: 'vad' },
        ];
        runtimeEvents.push(events);
        return { events };
      }),
      finish: vi.fn(async (input) => {
        expect(input.finalSeq).toBe(0);
        const events = [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: 'stt-pack-1' }];
        runtimeEvents.push(events);
        return { text: 'hello world', language: 'en', events };
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const transcribeAudio = vi.fn(async () => {
      throw new Error('runtime_mode_must_not_batch_transcribe');
    });
    const createStreamingTranscriptionSession = vi.fn(async () => runtimeSession);
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio,
        cancelStt: vi.fn(async () => {}),
        createStreamingTranscriptionSession,
      } as any,
    }) as unknown as { appendSttStreamBinaryFrame: BinaryAppendConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-runtime',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0, ackSeq: -1 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [
        { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
        { type: 'endpoint', seq: 0, transcript: 'hello', reason: 'vad' },
      ],
    });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([9, 9, 9, 9]),
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      events: [],
    });

    await expect(sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
      ackSeq: 0,
      finalText: 'hello world',
      language: 'en',
      modelPackId: 'stt-pack-1',
      events: [{ type: 'final', seq: 0, text: 'hello world', language: 'en', modelPackId: 'stt-pack-1' }],
    });

    expect(createStreamingTranscriptionSession).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stream-request-runtime',
      packId: 'stt-pack-1',
      language: 'en',
    }));
    expect(runtimeSession.appendPcm16).toHaveBeenCalledTimes(1);
    expect(runtimeSession.finish).toHaveBeenCalledTimes(1);
    expect(runtimeSession.close).toHaveBeenCalledTimes(1);
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(runtimeEvents.map((events) => (events[0] as { type: string }).type)).toEqual(['partial', 'final']);
  });

  it('fails closed when runtime streaming is requested but the worker cannot create a stream', async () => {
    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          throw new Error('unused');
        }),
        cancelStt: vi.fn(async () => {}),
      } as any,
    });
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-runtime-unavailable',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'runtime',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'runtime_unavailable',
    });
  });

  it('fails closed when streaming mode is omitted at the RPC boundary', async () => {
    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          throw new Error('omitted_mode_must_not_upload_bridge');
        }),
        cancelStt: vi.fn(async () => {}),
      } as any,
    });
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);

    await expect(sttStreamStart?.({
      requestId: 'stream-mode-omitted',
      packId: 'stt-pack-1',
      language: 'en',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'invalid_stream_state',
    });
  });

  it('cancels runtime streaming sessions and rejects mismatched generation appends', async () => {
    const runtimeSession: RuntimeStreamSession = {
      appendPcm16: vi.fn(async () => ({ events: [] })),
      finish: vi.fn(async () => ({ text: '', language: null, events: [] })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const cancelStt = vi.fn(async () => {});
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          throw new Error('unused');
        }),
        cancelStt,
        createStreamingTranscriptionSession: vi.fn(async () => runtimeSession),
      } as any,
    }) as unknown as { appendSttStreamBinaryFrame: BinaryAppendConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamCancel = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_CANCEL);

    const started = await sttStreamStart?.({
      requestId: 'stream-runtime-cancel',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'runtime',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });

    await expect(sttStreamCancel?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toEqual({
      ok: true,
      streamId: started.streamId,
      generation: started.generation,
    });
    expect(runtimeSession.cancel).toHaveBeenCalledOnce();
    expect(runtimeSession.close).toHaveBeenCalledOnce();
    expect(cancelStt).toHaveBeenCalledWith('stream-runtime-cancel');
  });

  it('rejects binary append stream identity, ordering, PCM, cap, and lifecycle violations', async () => {
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = '4';
    const finishRelease = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    })();
    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          await finishRelease.promise;
          return { requestId: 'stream-request-binary-negative', text: '', language: null, modelPackId: null };
        }),
        cancelStt: vi.fn(async () => {}),
      } as any,
    }) as unknown as { appendSttStreamBinaryFrame: BinaryAppendConsumer };
    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamFinish = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_FINISH);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-binary-negative',
      packId: null,
      language: null,
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: 'missing-stream',
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation + 1,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0, 1, 0, 2, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });

    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 0,
      pcm16Bytes: new Uint8Array([0, 0]),
    })).resolves.toMatchObject({ ok: true, ackSeq: 0 });
    const finishing = sttStreamFinish?.({
      streamId: started.streamId,
      generation: started.generation,
      finalSeq: 0,
    });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'invalid_stream_state' });
    finishRelease.resolve();
    await expect(finishing).resolves.toMatchObject({ ok: true });
    await expect(registration.appendSttStreamBinaryFrame({
      streamId: started.streamId,
      generation: started.generation,
      seq: 1,
      pcm16Bytes: new Uint8Array([1, 0]),
    })).resolves.toMatchObject({ ok: false, errorCode: 'stream_not_found' });
  });

  it('expires abandoned daemon STT streams and cancels their worker request', async () => {
    vi.useFakeTimers();
    const cancelStt = vi.fn(async () => {});
    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceStreamingRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: {
        transcribeAudio: vi.fn(async () => {
          throw new Error('unused');
        }),
        cancelStt,
      } as any,
    });

    const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
    const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);

    const started = await sttStreamStart?.({
      requestId: 'stream-request-expire',
      packId: 'stt-pack-1',
      language: 'en',
      streamingMode: 'upload_bridge',
    });
    expect(started).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });

    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({ ok: true, state: 'open' });

    await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1);

    await expect(sttStreamStatus?.({
      streamId: started.streamId,
      generation: started.generation,
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'stream_not_found',
    });
    expect(cancelStt).toHaveBeenCalledWith('stream-request-expire');
    expect(vi.getTimerCount()).toBe(0);
  });
});
