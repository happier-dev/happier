import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import {
  DaemonVoiceInferenceSttUploadAbortRequestSchema,
  DaemonVoiceInferenceSttUploadAbortResponseSchema,
  DaemonVoiceInferenceSttUploadChunkRequestSchema,
  DaemonVoiceInferenceSttUploadChunkResponseSchema,
  DaemonVoiceInferenceSttUploadFinalizeRequestSchema,
  DaemonVoiceInferenceSttUploadFinalizeResponseSchema,
  DaemonVoiceInferenceSttUploadInitRequestSchema,
  DaemonVoiceInferenceSttUploadInitResponseSchema,
  DaemonVoiceInferenceSttCancelRequestSchema,
  DaemonVoiceInferenceSttCancelResponseSchema,
  DaemonVoiceInferenceSttTranscribeRequestSchema,
  DaemonVoiceInferenceSttTranscribeResponseSchema,
  DaemonVoiceInferenceTtsAbortRequestSchema,
  DaemonVoiceInferenceTtsAbortResponseSchema,
  DaemonVoiceInferenceTtsCancelRequestSchema,
  DaemonVoiceInferenceTtsCancelResponseSchema,
  DaemonVoiceInferenceTtsChunkRequestSchema,
  DaemonVoiceInferenceTtsChunkResponseSchema,
  DaemonVoiceInferenceTtsFinalizeRequestSchema,
  DaemonVoiceInferenceTtsFinalizeResponseSchema,
  DaemonVoiceInferenceTtsSynthesizeRequestSchema,
  DaemonVoiceInferenceTtsSynthesizeResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import {
  resolveVoiceInferenceAcceptedInputMimeTypes,
  resolveVoiceInferenceSttMaxUploadBytes,
} from '@/daemon/voiceInference/voiceInferenceWorkerConfig';
import { resolveVoiceInferencePaths } from '@/daemon/voiceInference/voiceInferencePaths';
import {
  isVoiceInferenceWavMimeType,
  normalizeVoiceInferenceInputMimeType,
} from '@/daemon/voiceInference/voiceInferenceWorker.shared';

import type { VoiceInferenceWorkerHandle } from '@/daemon/voiceInference/voiceInferenceWorker';
import type { VoiceDiagnosticsController } from '@/daemon/voiceDiagnostics/controller';
import type { VoiceSpeechDiagnosticFormatV1 } from '@happier-dev/protocol';
import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';

import {
  parseVoiceInferenceResponse,
  toVoiceInferenceError,
  type VoiceInferenceSchemaParser,
} from './voiceInferenceRpcResponses';

function parseTransferLifecycleResponse<T>(schema: VoiceInferenceSchemaParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return schema.parse({
    success: false,
    error: 'internal_error',
    errorCode: 'internal_error',
  });
}

function resolveDiagnosticFormat(inputMimeType: string): VoiceSpeechDiagnosticFormatV1 | null {
  const normalized = normalizeVoiceInferenceInputMimeType(inputMimeType);
  if (isVoiceInferenceWavMimeType(normalized)) return 'wav';
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'audio/ogg' || normalized === 'audio/opus') return 'ogg';
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mpeg';
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a' || normalized === 'audio/m4a') return 'mp4';
  if (normalized === 'audio/flac' || normalized === 'audio/x-flac') return 'flac';
  if (normalized === 'audio/pcm' || normalized === 'audio/l16') return 'pcm16';
  return null;
}

export type MachineVoiceInferenceTransferRpcRegistration = Readonly<{
  downloadStore: TransferSessionStore;
  uploadStore: TransferSessionStore;
  dispose: () => Promise<void>;
}>;

export function registerMachineVoiceInferenceTransferRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  voiceInferenceWorker: VoiceInferenceWorkerHandle;
  voiceDiagnostics?: VoiceDiagnosticsController;
}>): MachineVoiceInferenceTransferRpcRegistration {
  const voiceInferencePaths = resolveVoiceInferencePaths();
  const voiceInferenceTransfersRoot = join(voiceInferencePaths.tempDir, 'transfers');
  const sessionTtlMs = Number.isFinite(configuration.filesTransferSessionTtlMs)
    ? Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs))
    : 60_000;
  const downloadStore = new TransferSessionStore({
    ttlMs: sessionTtlMs,
    tempRoot: voiceInferenceTransfersRoot,
  });
  const uploadStore = new TransferSessionStore({
    ttlMs: sessionTtlMs,
    tempRoot: voiceInferenceTransfersRoot,
  });
  const transferLifecycle = createTransferSessionLifecycle({
    store: downloadStore,
    chunkSizeBytes: configuration.filesTransferChunkBytes,
  });
  const uploadLifecycle = createTransferSessionLifecycle({
    store: uploadStore,
    chunkSizeBytes: configuration.filesTransferChunkBytes,
  });
  const finalizedUploadsById = new Map<string, Readonly<{
    path: string;
    sizeBytes: number;
    sha256: string;
    inputMimeType: string;
  }>>();
  const finalizedUploadReleaseTimerById = new Map<string, ReturnType<typeof setTimeout>>();
  const ttsDownloadReleaseTimerById = new Map<string, ReturnType<typeof setTimeout>>();
  const ttsDownloadFilePathById = new Map<string, string>();
  const uploadMimeTypeById = new Map<string, string>();
  let disposePromise: Promise<void> | null = null;

  function toPublicUploadTempPath(uploadId: string, absoluteUploadPath: string): string {
    // Avoid leaking absolute local machine paths over RPC. Keep a stable, relative hint for debugging.
    const rel = relative(voiceInferencePaths.tempDir, absoluteUploadPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return `upload:${uploadId}`;
    }
    return rel;
  }

  async function clearFinalizedUpload(uploadId: string, options?: Readonly<{ deleteFile?: boolean }>): Promise<void> {
    const timer = finalizedUploadReleaseTimerById.get(uploadId);
    if (timer) {
      clearTimeout(timer);
      finalizedUploadReleaseTimerById.delete(uploadId);
    }
    const uploaded = finalizedUploadsById.get(uploadId);
    finalizedUploadsById.delete(uploadId);
    uploadMimeTypeById.delete(uploadId);
    if (options?.deleteFile !== false && uploaded?.path) {
      await rm(uploaded.path, { force: true }).catch(() => undefined);
    }
  }

  function scheduleFinalizedUploadExpiry(uploadId: string): void {
    const existingTimer = finalizedUploadReleaseTimerById.get(uploadId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      void clearFinalizedUpload(uploadId);
    }, sessionTtlMs);
    finalizedUploadReleaseTimerById.set(uploadId, timer);
  }

  function clearTtsDownloadExpiry(downloadId: string): void {
    const timer = ttsDownloadReleaseTimerById.get(downloadId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    ttsDownloadReleaseTimerById.delete(downloadId);
  }

  function scheduleTtsDownloadExpiry(downloadId: string): void {
    clearTtsDownloadExpiry(downloadId);
    const timer = setTimeout(() => {
      void abortTtsDownloadTransfer(downloadId);
    }, sessionTtlMs);
    ttsDownloadReleaseTimerById.set(downloadId, timer);
  }

  async function abortTtsDownloadTransfer(downloadId: string): Promise<void> {
    clearTtsDownloadExpiry(downloadId);
    const filePath = ttsDownloadFilePathById.get(downloadId) ?? null;
    ttsDownloadFilePathById.delete(downloadId);
    await transferLifecycle.abortDownloadTransferSession({ downloadId }).catch(() => undefined);
    if (filePath) {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_SYNTHESIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsSynthesizeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    let synthesizedFilePath: string | null = null;
    let downloadId: string | null = null;
    try {
      const synthesized = await params.voiceInferenceWorker.synthesizeTts({
        requestId: parsed.data.requestId,
        text: parsed.data.text,
        packId: parsed.data.packId,
        voiceId: parsed.data.voiceId,
        speed: parsed.data.speed,
        output: parsed.data.output,
      });
      synthesizedFilePath = synthesized.filePath;
      if (parsed.data.diagnostics?.captureAllowed === true) {
        await params.voiceDiagnostics?.captureFile({
          direction: 'tts_output',
          format: 'wav',
          filePath: synthesized.filePath,
          durationMs: parsed.data.diagnostics.durationMs,
          sessionId: parsed.data.diagnostics.sessionId,
          authorizationId: parsed.data.diagnostics.authorizationId,
          providerId: parsed.data.packId ?? 'daemon-default',
          attemptId: parsed.data.requestId,
        });
      }
      const session = await transferLifecycle.openDownloadTransferSession({
        source: {
          filePath: synthesized.filePath,
          deleteFileOnClose: true,
          sizeBytes: synthesized.sizeBytes,
          name: synthesized.name,
        },
      });
      downloadId = session.downloadId;
      ttsDownloadFilePathById.set(session.downloadId, synthesized.filePath);
      const response = parseVoiceInferenceResponse(DaemonVoiceInferenceTtsSynthesizeResponseSchema, {
        ok: true,
        requestId: synthesized.requestId,
        output: synthesized.output,
        downloadId: session.downloadId,
        chunkSizeBytes: session.chunkSizeBytes,
        sizeBytes: synthesized.sizeBytes,
        name: synthesized.name,
      });
      if (!response.ok) {
        await abortTtsDownloadTransfer(session.downloadId);
        downloadId = null;
      } else {
        scheduleTtsDownloadExpiry(session.downloadId);
      }
      return response;
    } catch (error) {
      if (downloadId) {
        await abortTtsDownloadTransfer(downloadId);
      }
      if (synthesizedFilePath) {
        await rm(synthesizedFilePath, { force: true }).catch(() => undefined);
      }
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsChunkRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsChunkResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    const response = await transferLifecycle.readDownloadTransferChunk(parsed.data);
    if (response.success) {
      scheduleTtsDownloadExpiry(parsed.data.downloadId);
    }
    return parseTransferLifecycleResponse(
      DaemonVoiceInferenceTtsChunkResponseSchema,
      response,
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsFinalizeResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    try {
      await transferLifecycle.finalizeDownloadTransferSession(parsed.data);
      clearTtsDownloadExpiry(parsed.data.downloadId);
      ttsDownloadFilePathById.delete(parsed.data.downloadId);
      return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsFinalizeResponseSchema, { success: true });
    } catch (error) {
      const shaped = toVoiceInferenceError(error);
      return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsFinalizeResponseSchema, {
        success: false,
        error: shaped.error,
        errorCode: shaped.errorCode,
      });
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsAbortRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsAbortResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    await abortTtsDownloadTransfer(parsed.data.downloadId);
    return parseTransferLifecycleResponse(DaemonVoiceInferenceTtsAbortResponseSchema, { success: true });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_TTS_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceTtsCancelRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      await params.voiceInferenceWorker.cancelTts(parsed.data.requestId);
      return parseVoiceInferenceResponse(DaemonVoiceInferenceTtsCancelResponseSchema, { ok: true });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_INIT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttUploadInitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadInitResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    const normalizedInputMimeType = normalizeVoiceInferenceInputMimeType(parsed.data.inputMimeType);
    if (!normalizedInputMimeType) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadInitResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    if (
      !resolveVoiceInferenceAcceptedInputMimeTypes().includes(normalizedInputMimeType)
      && !isVoiceInferenceWavMimeType(normalizedInputMimeType)
    ) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadInitResponseSchema, {
        success: false,
        error: 'voice_inference_unsupported_daemon_audio_input',
        errorCode: 'invalid_audio_input',
      });
    }
    if (parsed.data.sizeBytes > resolveVoiceInferenceSttMaxUploadBytes()) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadInitResponseSchema, {
        success: false,
        error: 'voice_inference_upload_exceeds_configured_size_limit',
        errorCode: 'invalid_audio_input',
      });
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const session = await uploadLifecycle.openUploadTransferSession({
      target: {
        destPath: 'voice-inference-upload',
        destDisplayPath: 'voice-inference-upload',
        expectedSizeBytes: parsed.data.sizeBytes,
        overwrite: true,
        finalizeUpload: async ({ tempPath, sizeBytes, sha256 }) => ({
          success: true,
          path: tempPath,
          sizeBytes,
          result: {
            path: tempPath,
            sizeBytes,
            sha256,
            inputMimeType: parsed.data.inputMimeType,
          },
        }),
      },
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    uploadMimeTypeById.set(session.uploadId, normalizedInputMimeType);
    return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadInitResponseSchema, {
      success: true,
      uploadId: session.uploadId,
      chunkSizeBytes: session.chunkSizeBytes,
      recipientPublicKeyBase64: session.recipientPublicKeyBase64,
    });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttUploadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadChunkResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    return parseTransferLifecycleResponse(
      DaemonVoiceInferenceSttUploadChunkResponseSchema,
      await uploadLifecycle.writeUploadTransferChunk(parsed.data),
    );
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttUploadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadFinalizeResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    const finalized = await uploadLifecycle.finalizeUploadTransferSession(parsed.data);
    if (!finalized.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadFinalizeResponseSchema, {
        success: false,
        error: finalized.error,
      });
    }
    const result = finalized.finalized.result as Readonly<{
      path: string;
      sizeBytes: number;
      sha256: string;
      inputMimeType: string;
    }> | undefined;
    const fallbackInputMimeType = uploadMimeTypeById.get(parsed.data.uploadId) ?? 'application/octet-stream';
    const uploadPath = result?.path ?? finalized.finalized.path;
    await clearFinalizedUpload(parsed.data.uploadId, { deleteFile: false });
    finalizedUploadsById.set(parsed.data.uploadId, {
      path: uploadPath,
      sizeBytes: result?.sizeBytes ?? finalized.finalized.sizeBytes,
      sha256: result?.sha256 ?? finalized.sha256,
      inputMimeType: result?.inputMimeType ?? fallbackInputMimeType,
    });
    scheduleFinalizedUploadExpiry(parsed.data.uploadId);
    return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadFinalizeResponseSchema, {
      success: true,
      uploadId: parsed.data.uploadId,
      path: toPublicUploadTempPath(parsed.data.uploadId, uploadPath),
      sizeBytes: finalized.finalized.sizeBytes,
      sha256: finalized.sha256,
    });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_UPLOAD_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttUploadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadAbortResponseSchema, {
        success: false,
        error: 'invalid_parameters',
        errorCode: 'invalid_parameters',
      });
    }
    await uploadLifecycle.abortUploadTransferSession(parsed.data);
    await clearFinalizedUpload(parsed.data.uploadId);
    return parseTransferLifecycleResponse(DaemonVoiceInferenceSttUploadAbortResponseSchema, { success: true });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_TRANSCRIBE, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttTranscribeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    const uploaded = finalizedUploadsById.get(parsed.data.uploadId);
    if (!uploaded) {
      return toVoiceInferenceError(Object.assign(new Error('voice_inference_upload_missing'), { code: 'invalid_audio_input' }));
    }
    await clearFinalizedUpload(parsed.data.uploadId, { deleteFile: false });
    try {
      const diagnosticFormat = resolveDiagnosticFormat(uploaded.inputMimeType);
      const transcribed = await params.voiceInferenceWorker.transcribeAudio({
        requestId: parsed.data.requestId,
        uploadId: parsed.data.uploadId,
        packId: parsed.data.packId,
        language: parsed.data.language,
        normalization: parsed.data.normalization,
        filePath: uploaded.path,
        inputMimeType: uploaded.inputMimeType,
      });
      // Diagnostics are evidence of a completed provider operation, not merely an accepted
      // upload. Persist only after transcription succeeds so failed/cancelled attempts never
      // leave a misleading audio artifact behind.
      if (parsed.data.diagnostics?.captureAllowed === true && diagnosticFormat) {
        await params.voiceDiagnostics?.captureFile({
          direction: 'stt_input',
          format: diagnosticFormat,
          filePath: uploaded.path,
          durationMs: parsed.data.diagnostics.durationMs,
          sessionId: parsed.data.diagnostics.sessionId,
          authorizationId: parsed.data.diagnostics.authorizationId,
          providerId: parsed.data.packId ?? 'daemon-default',
          attemptId: parsed.data.requestId,
        });
      }
      return parseVoiceInferenceResponse(DaemonVoiceInferenceSttTranscribeResponseSchema, {
        ok: true,
        ...transcribed,
      });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_INFERENCE_STT_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceInferenceSttCancelRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return toVoiceInferenceError(new Error('invalid_parameters'));
    }
    try {
      await params.voiceInferenceWorker.cancelStt(parsed.data.requestId);
      return parseVoiceInferenceResponse(DaemonVoiceInferenceSttCancelResponseSchema, { ok: true });
    } catch (error) {
      return toVoiceInferenceError(error);
    }
  });

  return {
    downloadStore,
    uploadStore,
    dispose: async () => {
      if (disposePromise) {
        return await disposePromise;
      }

      disposePromise = (async () => {
        await Promise.all([
          ...[...finalizedUploadsById.keys()].map(async (uploadId) => {
            await clearFinalizedUpload(uploadId);
          }),
          ...[...ttsDownloadFilePathById.keys()].map(async (downloadId) => {
            await abortTtsDownloadTransfer(downloadId);
          }),
        ]);
        finalizedUploadsById.clear();
        finalizedUploadReleaseTimerById.clear();
        ttsDownloadReleaseTimerById.clear();
        ttsDownloadFilePathById.clear();
        uploadMimeTypeById.clear();
        await Promise.all([
          downloadStore.dispose(),
          uploadStore.dispose(),
        ]);
      })();

      return await disposePromise;
    },
  };
}
