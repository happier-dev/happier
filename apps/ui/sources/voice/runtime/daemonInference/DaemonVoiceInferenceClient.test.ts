import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';

const ensureVoiceConversationSessionForVoiceHomeMock = vi.hoisted(() => vi.fn());
const resolveVoiceHomeDaemonMachineIdMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const openLocalUploadSourceReaderMock = vi.hoisted(() => vi.fn());
const createProductionDaemonSpeechStreamingSttTransportMock = vi.hoisted(() => vi.fn());
const authorizedDiagnosticsContext = Object.freeze({
  sessionId: 'voice-session-1',
  captureAllowed: true as const,
  durationMs: null,
  authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
});

vi.mock('@/voice/persistence/voiceConversationSession', () => ({
  ensureVoiceConversationSessionForVoiceHome: (...args: any[]) => ensureVoiceConversationSessionForVoiceHomeMock(...args),
  resolveVoiceHomeDaemonMachineId: (...args: any[]) => resolveVoiceHomeDaemonMachineIdMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: (...args: any[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: any[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
  isRuntimeFeatureEnabled: (...args: any[]) => isRuntimeFeatureEnabledMock(...args),
}));

vi.mock('@/sync/runtime/files/localUploadSourceReader', () => ({
  openLocalUploadSourceReader: (...args: any[]) => openLocalUploadSourceReaderMock(...args),
}));

vi.mock('./DaemonSpeechStreamProductionTunnelTransport', () => ({
  createProductionDaemonSpeechStreamingSttTransport: (...args: any[]) =>
    createProductionDaemonSpeechStreamingSttTransportMock(...args),
}));

const DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS = 30_000;

describe('DaemonVoiceInferenceClient', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureVoiceConversationSessionForVoiceHomeMock.mockReset();
    resolveVoiceHomeDaemonMachineIdMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    isRuntimeFeatureEnabledMock.mockReset();
    openLocalUploadSourceReaderMock.mockReset();
    createProductionDaemonSpeechStreamingSttTransportMock.mockReset();

    ensureVoiceConversationSessionForVoiceHomeMock.mockResolvedValue('voice-home-session');
    resolveVoiceHomeDaemonMachineIdMock.mockReturnValue('machine-1');
    readMachineTargetForSessionMock.mockReturnValue({ machineId: 'machine-1', basePath: '/voice-home' });
    isRuntimeFeatureEnabledMock.mockResolvedValue(true);
    createProductionDaemonSpeechStreamingSttTransportMock.mockResolvedValue(null);
  });

  it('fails closed with feature_disabled before resolving machine scope when daemon inference is not enabled', async () => {
    isRuntimeFeatureEnabledMock.mockResolvedValue(false);

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      code: 'feature_disabled',
      message: 'daemon_voice_inference_feature_disabled',
    });

    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(resolveVoiceHomeDaemonMachineIdMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('runs machine-only model status without creating a voice-home session or requiring a directory', async () => {
    ensureVoiceConversationSessionForVoiceHomeMock.mockRejectedValue(new Error('voice_home_machine_unavailable'));
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, models: [] });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getModelsStatus()).resolves.toEqual([]);
    expect(resolveVoiceHomeDaemonMachineIdMock).toHaveBeenCalledTimes(1);
    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.models.status',
    }));
  });

  it('fails closed before a model mutation when its captured execution-machine scope is no longer current', async () => {
    resolveVoiceHomeDaemonMachineIdMock.mockReturnValue('machine-b');

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.installModel(
      { packId: 'kokoro-82m-v1.0-onnx-q8-wasm' },
      { machineId: 'machine-a' },
    )).rejects.toMatchObject({ code: 'machine_unreachable' });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('gives a model install its own deadline and forwards the caller lifetime to the daemon', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true, model: {} });
    const clientModule = await import('./DaemonVoiceInferenceClient');
    const client = new clientModule.DaemonVoiceInferenceClient();
    const caller = new AbortController();

    // The response shape is irrelevant here; only the issued request is.
    await client.installModel({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      signal: caller.signal,
    }).catch(() => undefined);

    const call = machineRpcWithServerScopeMock.mock.calls
      .map(([input]: any[]) => input)
      .find((input: any) => input.method === 'daemon.voiceInference.models.install');
    expect(call).toBeDefined();
    // The daemon aborts the install at the deadline the caller declares, so the
    // ordinary short RPC default would cancel a legitimate multi-minute download.
    expect(call.timeoutMs).toBe(clientModule.VOICE_MODEL_INSTALL_RPC_TIMEOUT_MS);
    expect(call.timeoutMs).toBeGreaterThan(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
    expect(call.signal).toBe(caller.signal);
  });

  it('downloads synthesized daemon TTS bytes through the selected daemon without creating a voice-home session', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.synthesize') {
        return {
          ok: true,
          requestId: 'tts-1',
          output: { codec: 'wav', mimeType: 'audio/wav' },
          downloadId: 'download-1',
          chunkSizeBytes: 1024,
          sizeBytes: 9,
          name: 'tts.wav',
        };
      }
      if (input.method === 'daemon.voiceInference.tts.chunk') {
        return {
          success: true,
          contentBase64: Buffer.from('voice-out').toString('base64'),
          isLast: true,
        };
      }
      if (input.method === 'daemon.voiceInference.tts.finalize') {
        return { success: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      resolveDiagnosticsCaptureContext: () => authorizedDiagnosticsContext,
    });
    const result = await client.synthesizeText({
      sessionId: 'voice-session-1',
      text: 'hello from daemon',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    expect(result.output).toEqual({ codec: 'wav', mimeType: 'audio/wav' });
    expect(Buffer.from(result.bytes).toString('utf8')).toBe('voice-out');
    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.tts.synthesize',
      payload: expect.objectContaining({
        text: 'hello from daemon',
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        output: { codec: 'wav', mimeType: 'audio/wav' },
        diagnostics: {
          sessionId: 'voice-session-1',
          captureAllowed: true,
          durationMs: null,
          authorizationId: expect.any(String),
        },
      }),
    }));
  });

  it('starts segmented daemon TTS, receives ready segments, and sends playback acknowledgements', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'tts-stream-1',
          generation: 0,
          segmentCount: 2,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.next') {
        return {
          ok: true,
          streamId: 'tts-stream-1',
          generation: 0,
          event: {
            type: 'segment',
            streamId: 'tts-stream-1',
            generation: 0,
            segmentId: 'tts-stream-1:0',
            segmentIndex: 0,
            segmentCount: 2,
            text: 'Hello.',
            textRange: { start: 0, end: 6 },
            textHash: 'hash0',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            audio: {
              contentBase64: Buffer.from('audio-0').toString('base64'),
              sizeBytes: 7,
            },
            isLastSegment: false,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.ack') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
          ackedSegmentIndex: input.payload.segmentIndex,
          complete: false,
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'tts-request-1',
      resolveDiagnosticsCaptureContext: () => authorizedDiagnosticsContext,
    });
    const stream = await client.startSegmentedTts({
      sessionId: 'voice-session-1',
      text: 'Hello. There.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.start',
      payload: expect.objectContaining({
        diagnostics: {
          sessionId: 'voice-session-1',
          captureAllowed: true,
          durationMs: null,
          authorizationId: expect.any(String),
        },
      }),
    }));

    const event = await stream.next();
    expect(event).toMatchObject({
      type: 'segment',
      streamId: 'tts-stream-1',
      segmentIndex: 0,
      bytes: new Uint8Array(Buffer.from('audio-0')),
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    if (event.type !== 'segment') throw new Error('expected segment');
    await stream.ackSegment(event);

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.tts.stream.start',
      payload: expect.objectContaining({
        requestId: 'tts-request-1',
        text: 'Hello. There.',
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.ack',
      payload: {
        streamId: 'tts-stream-1',
        generation: 0,
        segmentId: 'tts-stream-1:0',
        segmentIndex: 0,
      },
    }));
  });

  it('does not send segmented daemon TTS cancel after the final segment ack completes the stream', async () => {
    const abortController = new AbortController();
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'tts-stream-complete',
          generation: 0,
          segmentCount: 1,
          output: { codec: 'wav', mimeType: 'audio/wav' },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.next') {
        return {
          ok: true,
          streamId: 'tts-stream-complete',
          generation: 0,
          event: {
            type: 'segment',
            streamId: 'tts-stream-complete',
            generation: 0,
            segmentId: 'tts-stream-complete:0',
            segmentIndex: 0,
            segmentCount: 1,
            text: 'Done.',
            textRange: { start: 0, end: 5 },
            textHash: 'hash0',
            output: { codec: 'wav', mimeType: 'audio/wav' },
            audio: {
              contentBase64: Buffer.from('audio-0').toString('base64'),
              sizeBytes: 7,
            },
            isLastSegment: true,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.ack') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
          ackedSegmentIndex: input.payload.segmentIndex,
          complete: true,
        };
      }
      if (input.method === 'daemon.voiceInference.tts.stream.cancel') {
        return {
          ok: true,
          streamId: input.payload.streamId,
          generation: input.payload.generation,
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({ createRequestId: () => 'tts-request-complete' });
    const stream = await client.startSegmentedTts({
      text: 'Done.',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: abortController.signal,
    });

    const event = await stream.next();
    if (event.type !== 'segment') throw new Error('expected segment');
    await stream.ackSegment(event);
    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.stream.cancel',
    }));
  });

  it('threads the abort signal into the in-flight TTS synthesize RPC', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.synthesize') {
        return {
          ok: true,
          requestId: 'tts-1',
          output: { codec: 'wav', mimeType: 'audio/wav' },
          downloadId: 'download-1',
          chunkSizeBytes: 1024,
          sizeBytes: 9,
          name: 'tts.wav',
        };
      }
      if (input.method === 'daemon.voiceInference.tts.chunk') {
        return { success: true, contentBase64: Buffer.from('voice-out').toString('base64'), isLast: true };
      }
      if (input.method === 'daemon.voiceInference.tts.finalize') {
        return { success: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const controller = new AbortController();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();
    await client.synthesizeText({
      text: 'hello from daemon',
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      signal: controller.signal,
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'daemon.voiceInference.tts.synthesize',
      signal: controller.signal,
    }));
  });

  it('returns daemon status snapshots with progress and degraded service state intact', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        updatedAtMs: 99,
      }],
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).resolves.toEqual({
      ok: true,
      serviceState: 'degraded',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      models: [{
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-04-17',
        executionSupport: ['daemon'],
        installState: 'installing',
        progress: {
          phase: 'downloading',
          progress: 0.5,
          bytesDownloaded: 512,
          totalBytes: 1024,
          message: 'warming',
        },
        lastError: 'runtime_warmup_slow',
        pluginIdentity: null,
        updatedAtMs: 99,
      }],
    });
  });

  it('uploads recorded audio and returns daemon STT transcription', async () => {
    const recipientKeyPair = createTransferRecipientKeyPair();
    openLocalUploadSourceReaderMock.mockResolvedValue({
      sizeBytes: 5,
      readBytes: async () => Buffer.from('hello'),
      close: async () => {},
    });
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        return {
          success: true,
          uploadId: 'upload-1',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-1',
          path: '/tmp/upload-1.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-1',
          text: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const controller = new AbortController();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      resolveDiagnosticsCaptureContext: () => ({ ...authorizedDiagnosticsContext, durationMs: 1_250 }),
    });
    const result = await client.transcribeRecordedAudio({
      sessionId: 'voice-session-1',
      durationMs: 1_250,
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-1',
      language: 'en',
      signal: controller.signal,
    });

    expect(result).toEqual({
      text: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
      signal: controller.signal,
      payload: expect.objectContaining({
        packId: 'stt-pack-1',
        language: 'en',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        diagnostics: {
          sessionId: 'voice-session-1',
          captureAllowed: true,
          durationMs: 1_250,
          authorizationId: expect.any(String),
        },
      }),
    }));
  });

  it('cannot force diagnostics on when the canonical capture policy denies it', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.tts.synthesize') {
        return {
          ok: true,
          requestId: 'tts-denied',
          output: { codec: 'wav', mimeType: 'audio/wav' },
          downloadId: 'download-denied',
          chunkSizeBytes: 1024,
          sizeBytes: 1,
          name: 'tts.wav',
        };
      }
      if (input.method === 'daemon.voiceInference.tts.chunk') {
        return { success: true, contentBase64: Buffer.from('x').toString('base64'), isLast: true };
      }
      if (input.method === 'daemon.voiceInference.tts.finalize') return { success: true };
      throw new Error(`unexpected method: ${input.method}`);
    });
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({ resolveDiagnosticsCaptureContext: () => undefined });
    const legacyShapedInput: Parameters<typeof client.synthesizeText>[0] & { captureDiagnostics: true } = {
      sessionId: 'voice-session-1',
      captureDiagnostics: true,
      text: 'must stay private',
      packId: null,
      voiceId: null,
      speed: null,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    };

    await client.synthesizeText(legacyShapedInput);

    const synthesizeCall = machineRpcWithServerScopeMock.mock.calls
      .map(([input]) => input)
      .find((input) => input.method === 'daemon.voiceInference.tts.synthesize');
    expect(synthesizeCall.payload).not.toHaveProperty('diagnostics');
  });

  it('creates a streaming STT sender for the selected daemon without spawning an unrelated voice-home agent session', async () => {
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'synthetic-session-machine',
      basePath: '/synthetic-session',
    });
    ensureVoiceConversationSessionForVoiceHomeMock.mockRejectedValue(new Error('voice-home spawn must not gate daemon STT'));
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.stream.start') {
        return {
          ok: true,
          requestId: input.payload.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
        };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.chunk') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: input.payload.seq,
          events: [{ type: 'partial', seq: input.payload.seq, text: 'hel', isEndpoint: false, confidence: null }],
        };
      }
      if (input.method === 'daemon.voiceInference.stt.stream.finish') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: input.payload.finalSeq,
          finalText: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
          events: [{ type: 'final', seq: input.payload.finalSeq, text: 'hello daemon', language: 'en', modelPackId: 'stt-pack-1' }],
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const controller = new AbortController();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const resolveDiagnosticsCaptureContext = vi.fn((input: { sessionId: string | null | undefined }) => (
      input.sessionId
        ? {
            sessionId: input.sessionId,
            captureAllowed: true as const,
            durationMs: null,
            authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
          }
        : undefined
    ));
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'stream-request-1',
      resolveDiagnosticsCaptureContext,
    });
    const sender = await client.createStreamingSttSender({
      sessionId: 'active-control-session',
      packId: 'stt-pack-1',
      language: 'en',
      signal: controller.signal,
    });
    expect(sender.transportKind).toBe('json_rpc_compat');

    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([112, 99, 109]))).resolves.toEqual([
      { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
    ]);
    await expect(sender.finish()).resolves.toMatchObject({
      ok: true,
      finalText: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.start',
      signal: controller.signal,
      payload: expect.objectContaining({
        requestId: 'stream-request-1',
        packId: 'stt-pack-1',
        language: 'en',
        streamingMode: 'runtime',
        diagnostics: {
          sessionId: 'active-control-session',
          captureAllowed: true,
          durationMs: null,
          authorizationId: '6a42516d-20ea-4c70-91d5-b0dbaf693637',
        },
      }),
    }));
    expect(resolveDiagnosticsCaptureContext).toHaveBeenCalledWith({
      sessionId: 'active-control-session',
      direction: 'stt_input',
      durationMs: null,
    });
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.chunk',
      signal: controller.signal,
      payload: expect.objectContaining({
        streamId: 'stream-1',
        generation: 3,
        seq: 0,
        pcm16Base64: Buffer.from('pcm').toString('base64'),
      }),
    }));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.stream.finish',
      signal: controller.signal,
      payload: expect.objectContaining({
        streamId: 'stream-1',
        generation: 3,
        finalSeq: 0,
      }),
    }));
    expect(createProductionDaemonSpeechStreamingSttTransportMock).toHaveBeenCalledWith(expect.objectContaining({
      machineTarget: {
        machineId: 'machine-1',
      },
      requestId: 'stream-request-1',
      signal: controller.signal,
      compatibilityTransport: expect.any(Object),
    }));
    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
  });

  it('uses an injected binary tunnel transport for streaming chunks without calling the compatibility chunk RPC', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: unknown) => {
      const method = (input as { method?: string }).method;
      const payload = (input as { payload?: { requestId?: string; finalSeq?: number } }).payload;
      if (method === 'daemon.voiceInference.stt.stream.start') {
        return {
          ok: true,
          requestId: payload?.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
        };
      }
      if (method === 'daemon.voiceInference.stt.stream.finish') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: payload?.finalSeq,
          finalText: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
          events: [],
        };
      }
      if (method === 'daemon.voiceInference.stt.stream.chunk') {
        throw new Error('compatibility chunk RPC should not be used for binary tunnel transport');
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const { createDaemonSpeechStreamCarrierAdapter } = await import('./DaemonSpeechStreamCarrier');
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const tunnelChunk = vi.fn(async (payload) => {
      expect(payload.carrierFrame).toMatchObject({
        kind: 'binary_tunnel_frame_v2',
        sequence: {
          streamId: 'stream-1',
          generation: 3,
          seq: 0,
        },
      });
      if (payload.carrierFrame.kind !== 'binary_tunnel_frame_v2') {
        throw new Error('expected binary carrier frame');
      }
      expect([...payload.carrierFrame.payloadBytes]).toEqual([112, 99, 109]);
      expect(payload.compatibilityTransport).toBeNull();
      return {
        ok: true as const,
        streamId: payload.streamId,
        generation: payload.generation,
        ackSeq: payload.seq,
        events: [{ type: 'partial' as const, seq: payload.seq, text: 'hel', isEndpoint: false, confidence: null }],
      };
    });
    const createStreamingSttTransport = vi.fn(async ({ compatibilityTransport }) => ({
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({
        routeKind: 'loopback_direct',
        binaryCapable: true,
      }),
      transport: {
        ...compatibilityTransport,
        chunk: tunnelChunk,
      },
    }));
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'stream-request-1',
      createStreamingSttTransport,
    });

    const sender = await client.createStreamingSttSender({
      sessionId: 'qa-session',
      packId: 'stt-pack-1',
      language: 'en',
    });
    expect(sender.transportKind).toBe('binary_tunnel');
    expect(createStreamingSttTransport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'qa-session',
    }));

    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([112, 99, 109]))).resolves.toEqual([
      { type: 'partial', seq: 0, text: 'hel', isEndpoint: false, confidence: null },
    ]);
    await expect(sender.finish()).resolves.toMatchObject({
      ok: true,
      finalText: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });

    expect(tunnelChunk).toHaveBeenCalledTimes(1);
    const methods = machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method?: string }).method);
    expect(methods).toContain('daemon.voiceInference.stt.stream.start');
    expect(methods).toContain('daemon.voiceInference.stt.stream.finish');
    expect(methods).not.toContain('daemon.voiceInference.stt.stream.chunk');
  });

  it('uses the default production binary tunnel transport for streaming chunks without calling the compatibility chunk RPC', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: unknown) => {
      const method = (input as { method?: string }).method;
      const payload = (input as { payload?: { requestId?: string; finalSeq?: number } }).payload;
      if (method === 'daemon.voiceInference.stt.stream.start') {
        return {
          ok: true,
          requestId: payload?.requestId,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: -1,
          format: { sampleRateHz: 16_000, channelCount: 1, bitsPerSample: 16, ffmpegCodec: 'pcm_s16le' },
        };
      }
      if (method === 'daemon.voiceInference.stt.stream.finish') {
        return {
          ok: true,
          streamId: 'stream-1',
          generation: 3,
          ackSeq: payload?.finalSeq,
          finalText: 'hello daemon',
          language: 'en',
          modelPackId: 'stt-pack-1',
          events: [],
        };
      }
      if (method === 'daemon.voiceInference.stt.stream.chunk') {
        throw new Error('compatibility chunk RPC should not be used when the production tunnel opens');
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const { createDaemonSpeechStreamCarrierAdapter } = await import('./DaemonSpeechStreamCarrier');
    const tunnelChunk = vi.fn(async (payload) => {
      expect(payload.carrierFrame).toMatchObject({
        kind: 'binary_tunnel_frame_v2',
        frameEncoding: 'binary_frame_v2',
        sequence: {
          streamId: 'stream-1',
          generation: 3,
          seq: 0,
        },
      });
      return {
        ok: true as const,
        streamId: payload.streamId,
        generation: payload.generation,
        ackSeq: payload.seq,
        events: [],
      };
    });
    createProductionDaemonSpeechStreamingSttTransportMock.mockImplementation(async ({ compatibilityTransport }) => ({
      carrierAdapter: createDaemonSpeechStreamCarrierAdapter({
        routeKind: 'loopback_direct',
        binaryCapable: true,
      }),
      transport: {
        ...compatibilityTransport,
        chunk: tunnelChunk,
      },
    }));

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({ createRequestId: () => 'stream-request-1' });

    const sender = await client.createStreamingSttSender({
      packId: 'stt-pack-1',
      language: 'en',
    });
    expect(sender.transportKind).toBe('binary_tunnel');

    await sender.start();
    await expect(sender.pushChunk(new Uint8Array([112, 99, 109]))).resolves.toEqual([]);
    await expect(sender.finish()).resolves.toMatchObject({
      ok: true,
      finalText: 'hello daemon',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });

    const methods = machineRpcWithServerScopeMock.mock.calls.map(([input]) => (input as { method?: string }).method);
    expect(methods).toContain('daemon.voiceInference.stt.stream.start');
    expect(methods).toContain('daemon.voiceInference.stt.stream.finish');
    expect(methods).not.toContain('daemon.voiceInference.stt.stream.chunk');
    expect(createProductionDaemonSpeechStreamingSttTransportMock).toHaveBeenCalledTimes(1);
    expect(tunnelChunk).toHaveBeenCalledTimes(1);
  });

  it('reports JSON compatibility selection and can forbid it without sending stream RPCs', async () => {
    const recordStreamingSttTransportSelection = vi.fn();
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const allowedClient = new DaemonVoiceInferenceClient({
      createRequestId: () => 'compat-request',
      recordStreamingSttTransportSelection,
    });
    const sender = await allowedClient.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' });
    expect(sender.transportKind).toBe('json_rpc_compat');
    expect(recordStreamingSttTransportSelection).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'json_rpc_compat',
      sessionId: 'machine-1',
      machineId: 'machine-1',
    }));

    recordStreamingSttTransportSelection.mockClear();
    const forbiddenClient = new DaemonVoiceInferenceClient({
      createRequestId: () => 'forbidden-request',
      allowStreamingSttJsonRpcCompatibility: () => false,
      recordStreamingSttTransportSelection,
    });
    await expect(forbiddenClient.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' }))
      .rejects.toMatchObject({ code: 'stream_transport_unavailable' });
    expect(recordStreamingSttTransportSelection).toHaveBeenCalledWith(expect.objectContaining({
      transport: 'json_rpc_compat_forbidden',
    }));
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('preserves peer-route signing readiness details from production transport selection', async () => {
    createProductionDaemonSpeechStreamingSttTransportMock.mockRejectedValue(Object.assign(
      new Error('peer_route_signing_identity_unavailable'),
      {
        code: 'peer_route_signing_identity_unavailable',
        reasonCode: 'peer_route_signing_identity_unavailable',
        requiredCapability: 'peer_route_signing_identity_v1',
      },
    ));
    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      createRequestId: () => 'identity-unavailable-request',
      allowStreamingSttJsonRpcCompatibility: () => false,
    });

    await expect(client.createStreamingSttSender({ packId: 'stt-pack-1', language: 'en' }))
      .rejects.toMatchObject({
        code: 'peer_route_signing_identity_unavailable',
        reasonCode: 'peer_route_signing_identity_unavailable',
        requiredCapability: 'peer_route_signing_identity_v1',
      });
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
  });

  it('keeps recorded-audio STT pinned to the selected daemon even when a session id targets another machine', async () => {
    readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
      if (sessionId === 'qa-session-target') {
        return { machineId: 'machine-qa', basePath: '/qa-session' };
      }
      return { machineId: 'machine-1', basePath: '/voice-home' };
    });
    openLocalUploadSourceReaderMock.mockResolvedValue({
      sizeBytes: 5,
      readBytes: async () => Buffer.from('hello'),
      close: async () => {},
    });
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        const recipientKeyPair = createTransferRecipientKeyPair();
        return {
          success: true,
          uploadId: 'upload-qa',
          chunkSizeBytes: 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-qa',
          path: '/tmp/upload-qa.wav',
          sizeBytes: 5,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-qa',
          text: 'hello voice-home daemon',
          language: 'en',
          modelPackId: 'stt-pack-qa',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.transcribeRecordedAudio({
      sessionId: 'qa-session-target',
      source: { kind: 'native', uri: 'file:///recording.wav', sizeBytes: 5 },
      inputMimeType: 'audio/wav',
      packId: 'stt-pack-qa',
      language: 'en',
    })).resolves.toEqual({
      text: 'hello voice-home daemon',
      language: 'en',
      modelPackId: 'stt-pack-qa',
    });

    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      method: 'daemon.voiceInference.stt.transcribe',
    }));
  });

  it('uploads the admitted Chrome WebM file through the real web source reader', async () => {
    const { openLocalUploadSourceReader } = await vi.importActual<
      typeof import('@/sync/runtime/files/localUploadSourceReader')
    >('@/sync/runtime/files/localUploadSourceReader');
    const source = {
      kind: 'web' as const,
      file: new File(
        [new Uint8Array(1_080)],
        'recording.webm',
        { type: 'audio/webm;codecs=opus' },
      ),
    };
    const recipientKeyPair = createTransferRecipientKeyPair();
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.stt.upload.init') {
        return {
          success: true,
          uploadId: 'upload-chrome-webm',
          chunkSizeBytes: 64 * 1024,
          recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.chunk') {
        return { success: true };
      }
      if (input.method === 'daemon.voiceInference.stt.upload.finalize') {
        return {
          success: true,
          uploadId: 'upload-chrome-webm',
          path: '/tmp/upload-chrome-webm.webm',
          sizeBytes: 1_080,
          sha256: 'abc',
        };
      }
      if (input.method === 'daemon.voiceInference.stt.transcribe') {
        return {
          ok: true,
          requestId: 'stt-chrome-webm',
          text: 'open the project settings',
          language: 'en',
          modelPackId: 'stt-pack-qa',
        };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient({
      openLocalUploadSourceReader,
      createRequestId: () => 'stt-chrome-webm',
    });
    resolveVoiceHomeDaemonMachineIdMock.mockReturnValue(null);

    await expect(client.transcribeRecordedAudio({
      sessionId: 'qa-session-target',
      machineTarget: { machineId: 'machine-ready-at-start' },
      source,
      inputMimeType: 'audio/webm;codecs=opus',
      packId: 'stt-pack-qa',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      text: 'open the project settings',
      language: 'en',
      modelPackId: 'stt-pack-qa',
    });

    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-ready-at-start',
      method: 'daemon.voiceInference.stt.upload.init',
      payload: expect.objectContaining({
        sizeBytes: 1_080,
        inputMimeType: 'audio/webm;codecs=opus',
      }),
    }));
  });

  it('throws a machine-unreachable style error when the voice-home machine target cannot be resolved', async () => {
    resolveVoiceHomeDaemonMachineIdMock.mockReturnValue(null);

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.getStatus()).rejects.toMatchObject({
      message: 'daemon_voice_inference_machine_unreachable',
      code: 'machine_unreachable',
    });
  });

  it('lists, installs, removes, and refreshes daemon model status through the machine-scoped RPC namespace', async () => {
    machineRpcWithServerScopeMock.mockImplementation(async (input: any) => {
      if (input.method === 'daemon.voiceInference.models.list') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'not_installed',
              progress: null,
              lastError: null,
              updatedAtMs: 1,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.status') {
        return {
          ok: true,
          models: [
            {
              packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
              kind: 'tts_sherpa',
              model: 'kokoro',
              version: '2026-04-17',
              executionSupport: ['daemon'],
              installState: 'installing',
              progress: { phase: 'downloading', progress: 0.5, bytesDownloaded: 5, totalBytes: 10, message: null },
              lastError: null,
              updatedAtMs: 2,
            },
          ],
        };
      }
      if (input.method === 'daemon.voiceInference.models.install') {
        return {
          ok: true,
          model: {
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            kind: 'tts_sherpa',
            model: 'kokoro',
            version: '2026-04-17',
            executionSupport: ['daemon'],
            installState: 'installed',
            progress: null,
            lastError: null,
            updatedAtMs: 3,
          },
        };
      }
      if (input.method === 'daemon.voiceInference.models.remove') {
        return { ok: true };
      }
      throw new Error(`unexpected method: ${input.method}`);
    });

    const { DaemonVoiceInferenceClient } = await import('./DaemonVoiceInferenceClient');
    const client = new DaemonVoiceInferenceClient();

    await expect(client.listModels()).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        installState: 'not_installed',
      }),
    ]);
    await expect(client.getModelsStatus(['kokoro-82m-v1.0-onnx-q8-wasm'])).resolves.toEqual([
      expect.objectContaining({
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        installState: 'installing',
      }),
    ]);
    await expect(client.installModel({ packId: 'kokoro-82m-v1.0-onnx-q8-wasm' })).resolves.toMatchObject({
      packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
      installState: 'installed',
    });
    await expect(client.removeModel('kokoro-82m-v1.0-onnx-q8-wasm')).resolves.toBeUndefined();
    expect(resolveVoiceHomeDaemonMachineIdMock).toHaveBeenCalledTimes(4);
    expect(ensureVoiceConversationSessionForVoiceHomeMock).not.toHaveBeenCalled();
    expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
  });
});
