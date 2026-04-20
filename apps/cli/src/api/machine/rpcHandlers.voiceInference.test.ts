import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceModelStatus,
  DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';

import { registerMachineVoiceInferenceRpcHandlers } from './rpcHandlers.voiceInference';

type Handler = (data: any) => Promise<any>;

type VoiceInferenceWorkerHandleLike = Readonly<{
  stop: () => Promise<void> | void;
  getStatus: () => Promise<Readonly<{
    serviceState: 'unavailable' | 'idle' | 'warming' | 'ready' | 'degraded';
    normalization: DaemonVoiceInferenceNormalizationDecision;
    models: readonly DaemonVoiceInferenceModelStatus[];
  }>>;
  listModels: () => Promise<readonly DaemonVoiceInferenceModelStatus[]>;
  getModelsStatus: (packIds?: readonly string[] | null) => Promise<readonly DaemonVoiceInferenceModelStatus[]>;
  installModel: (input: Readonly<{ packId: string }>) => Promise<DaemonVoiceInferenceModelStatus>;
  removeModel: (packId: string) => Promise<void>;
  synthesizeTts: (input: Readonly<{
    requestId: string;
    text: string;
    packId: string | null;
    voiceId: string | null;
    speed: number | null;
    output: DaemonVoiceInferenceAudioOutput;
    signal?: AbortSignal | null;
  }>) => Promise<Readonly<{
    requestId: string;
    output: DaemonVoiceInferenceAudioOutput;
    filePath: string;
    sizeBytes: number;
    name: string;
  }>>;
  cancelTts: (requestId: string) => Promise<void>;
  transcribeAudio: (input: Readonly<{
    requestId: string;
    uploadId: string;
    filePath: string;
    inputMimeType: string;
    packId: string | null;
    language: string | null;
    normalization: DaemonVoiceInferenceNormalizationDecision;
    signal?: AbortSignal | null;
  }>) => Promise<Readonly<{
    requestId: string;
    text: string;
    language: string | null;
    modelPackId: string | null;
  }>>;
  cancelStt: (requestId: string) => Promise<void>;
}>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

function createEncryptedUploadChunkRequest(input: Readonly<{
  uploadId: string;
  index: number;
  payload: Buffer;
  recipientPublicKeyBase64: string;
}>) {
  const encryptedChunk = createEncryptedTransferChunkEnvelope({
    transferId: input.uploadId,
    sequence: input.index,
    payload: input.payload,
    recipientPublicKeyBase64: input.recipientPublicKeyBase64,
  });

  return {
    uploadId: input.uploadId,
    index: input.index,
    payloadBase64: encryptedChunk.payloadBase64,
    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('registerMachineVoiceInferenceRpcHandlers', () => {
  it('registers status, model management, TTS transfer, and STT upload/transcribe handlers', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-'));
    const outputBytes = Buffer.from('tts-audio');
    const outputPath = join(workspace, 'tts.mp3');
    writeFileSync(outputPath, outputBytes);

    const models: DaemonVoiceInferenceModelStatus[] = [
      {
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-02-15',
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 1,
      },
    ];

	    const installModel = vi.fn(async () => models[0]!);
	    const removeModel = vi.fn(async () => {});
	    const cancelTts = vi.fn(async () => {});
	    const cancelStt = vi.fn(async () => {});
	    let observedUploadedAudioText: string | null = null;
	    const transcribeAudio = vi.fn(async (input: Readonly<{ requestId: string; uploadId: string; language: string | null; filePath: string }>) => {
	      try {
	        observedUploadedAudioText = readFileSync(input.filePath, 'utf8');
	        return {
	          requestId: input.requestId,
	          text: 'hello daemon stt',
	          language: input.language,
	          modelPackId: 'stt-pack-1',
	        };
	      } finally {
	        // The daemon worker owns deletion for consumed uploads in production.
	        rmSync(input.filePath, { force: true });
	      }
	    });

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models,
      }),
      listModels: async () => models,
      getModelsStatus: async (packIds) => {
        if (!packIds || packIds.length === 0) return models;
        return models.filter((model) => packIds.includes(model.packId));
      },
      installModel,
      removeModel,
      synthesizeTts: async (input) => ({
        requestId: input.requestId,
        output: input.output,
        filePath: outputPath,
        sizeBytes: outputBytes.length,
        name: 'tts.mp3',
      }),
      cancelTts,
      transcribeAudio,
      cancelStt,
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const status = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS);
    const modelsList = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_LIST);
    const modelsStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS);
    const modelsInstall = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_INSTALL);
    const modelsRemove = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_REMOVE);
    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);
    const ttsChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK);
    const ttsFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE);
    const ttsCancel = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL);
    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);
    const sttCancel = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL);

    expect(status).toBeDefined();
    expect(modelsList).toBeDefined();
    expect(modelsStatus).toBeDefined();
    expect(modelsInstall).toBeDefined();
    expect(modelsRemove).toBeDefined();
    expect(ttsSynthesize).toBeDefined();
    expect(ttsChunk).toBeDefined();
    expect(ttsFinalize).toBeDefined();
    expect(ttsCancel).toBeDefined();
    expect(sttUploadInit).toBeDefined();
    expect(sttUploadChunk).toBeDefined();
    expect(sttUploadFinalize).toBeDefined();
    expect(sttTranscribe).toBeDefined();
    expect(sttCancel).toBeDefined();

    await expect(status?.({})).resolves.toEqual(expect.objectContaining({
      ok: true,
      serviceState: 'ready',
      models,
    }));
    await expect(modelsList?.({})).resolves.toEqual({ ok: true, models });
    await expect(modelsStatus?.({ packIds: ['kokoro-tts-en-v1'] })).resolves.toEqual({ ok: true, models });

    await expect(modelsInstall?.({ packId: 'kokoro-tts-en-v1' })).resolves.toEqual({
      ok: true,
      model: models[0],
    });
    expect(installModel).toHaveBeenCalledWith({ packId: 'kokoro-tts-en-v1' });

    await expect(modelsRemove?.({ packId: 'kokoro-tts-en-v1' })).resolves.toEqual({ ok: true });
    expect(removeModel).toHaveBeenCalledWith('kokoro-tts-en-v1');

    const synthResp = await ttsSynthesize?.({
      requestId: 'tts-1',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'mp3', mimeType: 'audio/mpeg' },
    });
    expect(synthResp).toEqual({
      ok: true,
      requestId: 'tts-1',
      output: { codec: 'mp3', mimeType: 'audio/mpeg' },
      downloadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      sizeBytes: outputBytes.length,
      name: 'tts.mp3',
    });

    const chunkResp = await ttsChunk?.({ downloadId: synthResp.downloadId, index: 0 });
    expect(chunkResp).toEqual({
      success: true,
      contentBase64: outputBytes.toString('base64'),
      isLast: true,
    });

    await expect(ttsFinalize?.({ downloadId: synthResp.downloadId })).resolves.toEqual({ success: true });
    await expect(ttsCancel?.({ requestId: 'tts-1' })).resolves.toEqual({ ok: true });
    expect(cancelTts).toHaveBeenCalledWith('tts-1');

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-1',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    const uploadFinalizeResp = await sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId });
    expect(uploadFinalizeResp).toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: 5,
      sha256: expect.any(String),
    });
    // `path` is relative to the daemon's voice inference temp dir (not an absolute host path) to avoid leaking PII.
    expect(isAbsolute(uploadFinalizeResp.path)).toBe(false);
    expect(uploadFinalizeResp.path.includes('..')).toBe(false);

    await expect(sttTranscribe?.({
      requestId: 'stt-1',
      uploadId: uploadInitResp.uploadId,
      packId: 'stt-pack-1',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      ok: true,
      requestId: 'stt-1',
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });
    expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'stt-1',
      uploadId: uploadInitResp.uploadId,
      inputMimeType: 'audio/wav',
      language: 'en',
    }));

	    const transcribeCall = (transcribeAudio as unknown as { mock: { calls: any[][] } }).mock.calls[0]?.[0] as { filePath?: string } | undefined;
	    expect(typeof transcribeCall?.filePath).toBe('string');
	    const transcribeFilePath = String(transcribeCall?.filePath ?? '');
	    expect(observedUploadedAudioText).toBe('hello');

    const { resolveVoiceInferencePaths } = await import('@/daemon/voiceInference/voiceInferencePaths');
    const { tempDir } = resolveVoiceInferencePaths();
    const finalizedUploadFilePath = join(tempDir, uploadFinalizeResp.path);
    expect(transcribeFilePath).toBe(finalizedUploadFilePath);
	    const relToTemp = relative(tempDir, transcribeFilePath);
	    expect(relToTemp).not.toBe('');
	    expect(relToTemp.startsWith('..')).toBe(false);

	    // Privacy hardening: the daemon should not retain user audio uploads after transcription completes.
	    expect(existsSync(transcribeFilePath)).toBe(false);

    await expect(sttCancel?.({ requestId: 'stt-1' })).resolves.toEqual({ ok: true });
    expect(cancelStt).toHaveBeenCalledWith('stt-1');
  });

  it('rejects STT transcribe payloads with undeclared fields at the RPC boundary', async () => {
    const transcribeAudio = vi.fn(async () => ({
      requestId: 'stt-1',
      text: 'hello daemon stt',
      language: 'en',
      modelPackId: 'stt-pack-1',
    }));

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio,
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-1',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toMatchObject({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
    });

    await expect(sttTranscribe?.({
      requestId: 'stt-1',
      uploadId: uploadInitResp.uploadId,
      packId: 'stt-pack-1',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
      // Undeclared field: should be rejected by strict protocol schema.
      inputMimeType: 'audio/wav',
    })).resolves.toMatchObject({
      ok: false,
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('deduplicates warm RPC pack ids and returns refreshed model status from the worker', async () => {
    const models: DaemonVoiceInferenceModelStatus[] = [
      {
        packId: 'kokoro-tts-en-v1',
        kind: 'tts_sherpa',
        model: 'kokoro',
        version: '2026-02-15',
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 1,
      },
      {
        packId: 'sherpa-stt-en-v1',
        kind: 'stt_sherpa',
        model: 'sherpa',
        version: '2026-02-15',
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 2,
      },
    ];

    const warmCalls: string[] = [];
    const getModelsStatus = vi.fn(async (packIds?: readonly string[] | null) => {
      if (!packIds || packIds.length === 0) return models;
      return models.filter((model) => packIds.includes(model.packId));
    });

    const worker: VoiceInferenceWorkerHandleLike & { warmModelPack: (packId: string) => Promise<void> } = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models,
      }),
      listModels: async () => models,
      getModelsStatus,
      installModel: async () => models[0]!,
      removeModel: async () => {},
      synthesizeTts: async () => ({
        requestId: 'tts-1',
        output: { codec: 'wav', mimeType: 'audio/wav' },
        filePath: join(mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-')), 'tts.wav'),
        sizeBytes: 1,
        name: 'tts.wav',
      }),
      cancelTts: async () => {},
      transcribeAudio: async () => ({
        requestId: 'stt-1',
        text: 'unused',
        language: 'en',
        modelPackId: 'sherpa-stt-en-v1',
      }),
      cancelStt: async () => {},
      warmModelPack: async (packId: string) => {
        warmCalls.push(packId);
      },
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const warm = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_WARM);
    expect(warm).toBeDefined();

    await expect(warm?.({
      packIds: ['kokoro-tts-en-v1', 'sherpa-stt-en-v1', 'kokoro-tts-en-v1'],
    })).resolves.toEqual({
      ok: true,
      models,
    });
    expect(warmCalls).toEqual(['kokoro-tts-en-v1', 'sherpa-stt-en-v1']);
    expect(getModelsStatus).toHaveBeenCalledWith(['kokoro-tts-en-v1', 'sherpa-stt-en-v1']);
  });

  it('rejects STT upload init requests that exceed the configured max upload size', async () => {
    const previousMaxUploadBytes = process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
    process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = '4';
    try {
      const worker: VoiceInferenceWorkerHandleLike = {
        stop: async () => {},
        getStatus: async () => ({
          serviceState: 'ready',
          normalization: {
            inputTransport: 'upload_transfer',
            strategy: 'daemon_decode',
            systemFfmpegAllowed: false,
          },
          models: [],
        }),
        listModels: async () => [],
        getModelsStatus: async () => [],
        installModel: async () => ({
          packId: 'kokoro-tts-en-v1',
          kind: 'tts_sherpa',
          model: 'kokoro',
          version: '2026-02-15',
          executionSupport: ['daemon'],
          installState: 'installed',
          progress: null,
          lastError: null,
          updatedAtMs: 1,
        }),
        removeModel: async () => {},
        synthesizeTts: async () => ({
          requestId: 'tts-1',
          output: { codec: 'mp3', mimeType: 'audio/mpeg' },
          filePath: join(mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-')), 'tts.mp3'),
          sizeBytes: 1,
          name: 'tts.mp3',
        }),
        cancelTts: async () => {},
        transcribeAudio: async () => ({
          requestId: 'stt-1',
          text: 'unused',
          language: 'en',
          modelPackId: 'stt-pack-1',
        }),
        cancelStt: async () => {},
      };

      const mgr = createRpcHandlerManager();
      registerMachineVoiceInferenceRpcHandlers({
        rpcHandlerManager: mgr as any,
        voiceInferenceWorker: worker as any,
      });

      const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      await expect(sttUploadInit?.({
        requestId: 'stt-oversize',
        sizeBytes: 5,
        inputMimeType: 'audio/wav',
      })).resolves.toEqual({
        success: false,
        error: expect.stringContaining('size'),
        errorCode: expect.any(String),
      });
    } finally {
      if (previousMaxUploadBytes === undefined) {
        delete process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES;
      } else {
        process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = previousMaxUploadBytes;
      }
    }
  });

  it('rejects STT upload init requests with unsupported input mime types', async () => {
    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => ({
        packId: 'unused',
        kind: 'tts_sherpa',
        model: 'unused',
        version: '1',
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 1,
      }),
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio: async () => ({
        requestId: 'unused',
        text: 'unused',
        language: null,
        modelPackId: null,
      }),
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    await expect(sttUploadInit?.({
      requestId: 'stt-unsupported-mime',
      sizeBytes: 1,
      inputMimeType: 'text/plain',
    })).resolves.toEqual({
      success: false,
      error: expect.any(String),
      errorCode: 'invalid_audio_input',
    });

    await expect(sttUploadInit?.({
      requestId: 'stt-octet-stream',
      sizeBytes: 1,
      inputMimeType: 'application/octet-stream',
    })).resolves.toEqual({
      success: false,
      error: expect.any(String),
      errorCode: 'invalid_audio_input',
    });
  });

  it('expires finalized STT uploads and deletes their temp files after the transfer TTL', async () => {
    vi.useFakeTimers();
    const mgr = createRpcHandlerManager();
    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => ({
        packId: 'unused',
        kind: 'tts_sherpa',
        model: 'unused',
        version: '1',
        executionSupport: ['daemon'],
        installState: 'installed',
        progress: null,
        lastError: null,
        updatedAtMs: 1,
      }),
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio: async () => ({
        requestId: 'unused',
        text: 'unused',
        language: null,
        modelPackId: null,
      }),
      cancelStt: async () => {},
    };

    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-expire',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });
    expect(uploadInitResp).toEqual({
      success: true,
      uploadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      recipientPublicKeyBase64: expect.any(String),
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

	    const uploadFinalizeResp = await sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId });
	    expect(uploadFinalizeResp).toEqual({
	      success: true,
	      uploadId: uploadInitResp.uploadId,
	      path: expect.any(String),
	      sizeBytes: 5,
	      sha256: expect.any(String),
	    });
	    expect(isAbsolute(uploadFinalizeResp.path)).toBe(false);
	    expect(uploadFinalizeResp.path.includes('..')).toBe(false);
	    const { resolveVoiceInferencePaths } = await import('@/daemon/voiceInference/voiceInferencePaths');
	    const { tempDir } = resolveVoiceInferencePaths();
	    const finalizedUploadFilePath = join(tempDir, uploadFinalizeResp.path);
	    expect(readFileSync(finalizedUploadFilePath, 'utf8')).toBe('hello');

	    await vi.advanceTimersByTimeAsync(10 * 60_000);
	    await vi.runOnlyPendingTimersAsync();
	    await Promise.resolve();
	    // The expiry callback deletes asynchronously; give it a couple ticks to settle.
	    let exists = true;
	    for (let i = 0; i < 5; i += 1) {
	      try {
	        await access(finalizedUploadFilePath);
	        await vi.advanceTimersByTimeAsync(1);
	        await Promise.resolve();
	      } catch {
	        exists = false;
	        break;
	      }
	    }
	    expect(exists).toBe(false);

    await expect(sttTranscribe?.({
      requestId: 'stt-expire',
      uploadId: uploadInitResp.uploadId,
      packId: 'stt-pack-1',
      language: 'en',
      normalization: {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_audio_input',
      error: expect.any(String),
    });

    vi.useRealTimers();
  });

  it('uses the finalized upload MIME type as the STT source of truth', async () => {
    const transcribeAudio = vi.fn(async (input: Readonly<{ requestId: string; inputMimeType: string; filePath: string }>) => {
      try {
        return {
          requestId: input.requestId,
          text: `mime:${input.inputMimeType}`,
          language: 'en',
          modelPackId: 'stt-pack-1',
        };
      } finally {
        rmSync(input.filePath, { force: true });
      }
    });

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio,
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-source-of-truth',
      sizeBytes: 5,
      inputMimeType: 'audio/webm',
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: 5,
      sha256: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-source-of-truth',
	      uploadId: uploadInitResp.uploadId,
	      packId: 'stt-pack-1',
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: true,
      requestId: 'stt-source-of-truth',
      text: 'mime:audio/webm',
      language: 'en',
      modelPackId: 'stt-pack-1',
    });

    expect(transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
      inputMimeType: 'audio/webm',
    }));
  });

  it('cleans up finalized STT uploads after transcribe failures', async () => {
    const transcribeAudio = vi.fn(async (input: Readonly<{ filePath: string }>) => {
      try {
        throw Object.assign(new Error('decode failed'), { code: 'unsupported_codec' });
      } finally {
        rmSync(input.filePath, { force: true });
      }
    });

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio,
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
    const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
    const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
    const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);

    const uploadInitResp = await sttUploadInit?.({
      requestId: 'stt-failed-upload',
      sizeBytes: 5,
      inputMimeType: 'audio/wav',
    });

    await expect(sttUploadChunk?.(
      createEncryptedUploadChunkRequest({
        uploadId: uploadInitResp.uploadId,
        index: 0,
        payload: Buffer.from('hello'),
        recipientPublicKeyBase64: uploadInitResp.recipientPublicKeyBase64,
      }),
    )).resolves.toEqual({ success: true });

    await expect(sttUploadFinalize?.({ uploadId: uploadInitResp.uploadId })).resolves.toEqual({
      success: true,
      uploadId: uploadInitResp.uploadId,
      path: expect.any(String),
      sizeBytes: 5,
      sha256: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-first-failure',
	      uploadId: uploadInitResp.uploadId,
	      packId: 'stt-pack-1',
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_codec',
      error: expect.any(String),
    });

	    await expect(sttTranscribe?.({
	      requestId: 'stt-second-failure',
	      uploadId: uploadInitResp.uploadId,
	      packId: 'stt-pack-1',
	      language: 'en',
	      normalization: {
	        inputTransport: 'upload_transfer',
	        strategy: 'daemon_decode',
	        systemFfmpegAllowed: false,
	      },
	    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_audio_input',
      error: expect.any(String),
    });

    expect(transcribeAudio).toHaveBeenCalledTimes(1);
  });

  it('redacts internal daemon/runtime details from RPC error payloads', async () => {
    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw Object.assign(
          new Error('voice_inference_daemon_decoder_spawn_failed:/Users/leeroy/private/input.m4a stderr=/tmp/runtime.log'),
          { code: 'runtime_unavailable' },
        );
      },
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);

    await expect(ttsSynthesize?.({
      requestId: 'tts-redacted',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_unavailable',
      error: 'voice_inference_runtime_unavailable',
    });
  });

  it('redacts internal daemon/runtime details from TTS finalize RPC error payloads', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-finalize-redact-'));
    const outputBytes = Buffer.from('tts-audio');
    const outputPath = join(workspace, 'tts.wav');
    writeFileSync(outputPath, outputBytes);

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async (input) => ({
        requestId: input.requestId,
        output: input.output,
        filePath: outputPath,
        sizeBytes: outputBytes.length,
        name: 'tts.wav',
      }),
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);
    const ttsFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE);
    const ttsAbort = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT);

    const synthResp = await ttsSynthesize?.({
      requestId: 'tts-finalize-redact',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(synthResp).toMatchObject({ ok: true });

    // Simulate an unexpected internal failure during transfer finalization. The RPC boundary must not leak this.
    vi.spyOn(TransferSessionStore.prototype, 'closeDownloadSession').mockRejectedValueOnce(
      new Error('voice_inference_daemon_decoder_spawn_failed:/Users/leeroy/private/input.m4a stderr=/tmp/runtime.log'),
    );

    await expect(ttsFinalize?.({ downloadId: synthResp.downloadId })).resolves.toEqual({
      success: false,
      errorCode: 'internal_error',
      error: 'voice_inference_internal_error',
    });

    // Cleanup: avoid leaving a long-lived expiry timer behind if finalization fails.
    await expect(ttsAbort?.({ downloadId: synthResp.downloadId })).resolves.toEqual({ success: true });
  });

  it('fails closed when a worker returns an invalid model-status success payload', async () => {
    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [
        {
          packId: 'broken-pack',
          kind: 'tts_sherpa',
          model: 'broken',
          executionSupport: ['daemon'],
          installState: 'installed',
          progress: null,
          lastError: null,
          updatedAtMs: 'not-a-number',
        } as any,
      ],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async () => {
        throw new Error('unused');
      },
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const modelsStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_MODELS_STATUS);

    await expect(modelsStatus?.({ packIds: ['broken-pack'] })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: expect.any(String),
    });
  });

  it('fails closed and cleans up synthesized temp files when opening the TTS transfer session fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-invalid-'));
    const outputPath = join(workspace, 'tts.mp3');
    writeFileSync(outputPath, Buffer.from('tts-audio'));
    chmodSync(outputPath, 0o000);

    const synthesizeTts = vi.fn(async (input: Readonly<{ requestId: string }>) => ({
      requestId: input.requestId,
      output: { codec: 'mp3', mimeType: 'audio/mpeg' } as const,
      filePath: outputPath,
      sizeBytes: 9,
      name: 'tts.mp3',
    }));

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts,
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);

    await expect(ttsSynthesize?.({
      requestId: 'tts-invalid',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'mp3', mimeType: 'audio/mpeg' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: expect.any(String),
    });

    expect(synthesizeTts).toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(false);
  });

  it('expires abandoned TTS download sessions and deletes their temp files without later RPC traffic', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-rpc-expire-'));
    const outputPath = join(workspace, 'tts.wav');
    writeFileSync(outputPath, Buffer.from('tts-audio'));

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts: async (input) => ({
        requestId: input.requestId,
        output: { codec: 'wav', mimeType: 'audio/wav' },
        filePath: outputPath,
        sizeBytes: 9,
        name: 'tts.wav',
      }),
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);
    const ttsChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK);

    const synthResp = await ttsSynthesize?.({
      requestId: 'tts-expire',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
    });
    expect(synthResp).toEqual({
      ok: true,
      requestId: 'tts-expire',
      output: { codec: 'wav', mimeType: 'audio/wav' },
      downloadId: expect.any(String),
      chunkSizeBytes: expect.any(Number),
      sizeBytes: 9,
      name: 'tts.wav',
    });
    expect(readFileSync(outputPath, 'utf8')).toBe('tts-audio');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    let fileDeleted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await access(outputPath);
      } catch {
        fileDeleted = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(fileDeleted).toBe(true);
    await expect(ttsChunk?.({ downloadId: synthResp.downloadId, index: 0 })).resolves.toEqual({
      success: false,
      error: 'Download session not found',
    });

    vi.useRealTimers();
  });

  it('rejects daemon TTS synthesize requests with undeclared fields before reaching the worker', async () => {
    const synthesizeTts = vi.fn(async () => {
      throw new Error('unused');
    });

    const worker: VoiceInferenceWorkerHandleLike = {
      stop: async () => {},
      getStatus: async () => ({
        serviceState: 'ready',
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
        models: [],
      }),
      listModels: async () => [],
      getModelsStatus: async () => [],
      installModel: async () => {
        throw new Error('unused');
      },
      removeModel: async () => {},
      synthesizeTts,
      cancelTts: async () => {},
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });

    const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);

    await expect(ttsSynthesize?.({
      requestId: 'tts-invalid-extra-field',
      text: 'Hello from daemon',
      packId: 'kokoro-tts-en-v1',
      voiceId: 'af_heart',
      speed: 1,
      output: { codec: 'wav', mimeType: 'audio/wav' },
      unexpectedField: 'should-be-rejected',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: expect.any(String),
    });

    expect(synthesizeTts).not.toHaveBeenCalled();
  });
});
