import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceModelStatus,
  DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';

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
  transcribeAudio: () => Promise<never>;
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

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('registerMachineVoiceInferenceRpcHandlers transfer lifecycle', () => {
  it('expires an abandoned STT upload without any later transfer traffic', async () => {
    vi.useFakeTimers();
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
      transcribeAudio: async () => {
        throw new Error('unused');
      },
      cancelStt: async () => {},
    };

    const mgr = createRpcHandlerManager();
    const registration = registerMachineVoiceInferenceRpcHandlers({
      rpcHandlerManager: mgr as any,
      voiceInferenceWorker: worker as any,
    });
    try {
      const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      if (!sttUploadInit) {
        throw new Error('expected voice inference upload init handler');
      }
      const upload = await sttUploadInit({
        requestId: 'stt-abandoned',
        sizeBytes: 5,
        inputMimeType: 'audio/wav',
      });
      expect(upload).toMatchObject({ success: true, uploadId: expect.any(String) });
      const uploadStore = registration.voiceInferenceTransfers.uploadStore;
      const tempPath = uploadStore.getUploadSession(upload.uploadId)?.tempPath;
      expect(tempPath).toBeTypeOf('string');
      await expect(access(tempPath!)).resolves.toBeUndefined();

      // The client disappears right after init: no chunk, no finalize, no abort,
      // and no unrelated transfer traffic that could sweep on its behalf.
      await vi.advanceTimersByTimeAsync(configuration.filesTransferSessionTtlMs + 1_000);
      await uploadStore.settleClosures();

      expect(uploadStore.getUploadSession(upload.uploadId)).toBeNull();
      await expectPathMissing(tempPath!);
    } finally {
      await registration.dispose();
    }
  });

  it('disposes abandoned TTS downloads and finalized STT uploads', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'happier-voice-inference-lifecycle-'));
    const outputBytes = Buffer.from('tts-audio');
    const outputPath = join(workspace, 'tts.wav');
    writeFileSync(outputPath, outputBytes);

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
      const registration = registerMachineVoiceInferenceRpcHandlers({
        rpcHandlerManager: mgr as any,
        voiceInferenceWorker: worker as any,
      });
      expect(registration).toBeTruthy();

      const ttsSynthesize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE);
      const ttsChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK);
      const sttUploadInit = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT);
      const sttUploadChunk = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK);
      const sttUploadFinalize = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE);
      const sttTranscribe = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE);
      const sttStreamStart = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_START);
      const sttStreamStatus = mgr.handlers.get(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_STREAM_STATUS);
      if (!ttsSynthesize || !ttsChunk || !sttUploadInit || !sttUploadChunk || !sttUploadFinalize || !sttTranscribe || !sttStreamStart || !sttStreamStatus) {
        throw new Error('expected voice inference transfer handlers');
      }

      const synth = await ttsSynthesize({
        requestId: 'tts-lifecycle',
        text: 'Hello',
        packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
        voiceId: 'af_heart',
        speed: 1,
        output: { codec: 'wav', mimeType: 'audio/wav' },
      });
      expect(synth).toMatchObject({ ok: true, downloadId: expect.any(String) });
      expect(registration.voiceInferenceTransfers.downloadStore.getDownloadSession(synth.downloadId)).toBeTruthy();
      await expect(access(outputPath)).resolves.toBeUndefined();

      const stream = await sttStreamStart({
        requestId: 'stt-stream-lifecycle',
        packId: 'stt-pack-1',
        language: 'en',
        streamingMode: 'upload_bridge',
      });
      expect(stream).toMatchObject({ ok: true, streamId: expect.any(String), generation: 0 });
      await expect(sttStreamStatus({
        streamId: stream.streamId,
        generation: stream.generation,
      })).resolves.toMatchObject({ ok: true, state: 'open' });

      const uploadPayload = Buffer.from('hello');
      const upload = await sttUploadInit({
        requestId: 'stt-lifecycle',
        sizeBytes: uploadPayload.length,
        inputMimeType: 'audio/wav',
      });
      expect(upload).toMatchObject({
        success: true,
        uploadId: expect.any(String),
        recipientPublicKeyBase64: expect.any(String),
      });
      await expect(sttUploadChunk(createEncryptedUploadChunkRequest({
        uploadId: upload.uploadId,
        index: 0,
        payload: uploadPayload,
        recipientPublicKeyBase64: upload.recipientPublicKeyBase64,
      }))).resolves.toEqual({ success: true });
      const finalized = await sttUploadFinalize({ uploadId: upload.uploadId });
      expect(finalized).toMatchObject({ success: true, path: expect.any(String) });
      const finalizedPath = join(resolveVoiceInferencePaths().tempDir, finalized.path);
      await expect(access(finalizedPath)).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

      await registration.dispose();
      await registration.dispose();

      expect(registration.voiceInferenceTransfers.downloadStore.getDownloadSession(synth.downloadId)).toBeNull();
      expect(registration.voiceInferenceTransfers.uploadStore.getUploadSession(upload.uploadId)).toBeNull();
      await expectPathMissing(outputPath);
      await expectPathMissing(finalizedPath);
      expect(vi.getTimerCount()).toBe(0);
      await expect(ttsChunk({ downloadId: synth.downloadId, index: 0 })).resolves.toEqual({
        success: false,
        error: 'Download session not found',
      });
      await expect(sttTranscribe({
        requestId: 'stt-after-dispose',
        uploadId: upload.uploadId,
        packId: null,
        language: null,
        normalization: {
          inputTransport: 'upload_transfer',
          strategy: 'daemon_decode',
          systemFfmpegAllowed: false,
        },
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'invalid_audio_input',
      });
      await expect(sttUploadInit({
        requestId: 'stt-after-dispose',
        sizeBytes: 1,
        inputMimeType: 'audio/wav',
      })).rejects.toThrow('Transfer session store is disposed');
      await expect(sttStreamStatus({
        streamId: stream.streamId,
        generation: stream.generation,
      })).resolves.toMatchObject({
        ok: false,
        errorCode: 'stream_not_found',
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
