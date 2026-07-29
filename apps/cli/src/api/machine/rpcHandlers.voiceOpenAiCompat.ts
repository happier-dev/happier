import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES,
  DaemonVoiceOpenAiCompatChatRequestSchema,
  DaemonVoiceOpenAiCompatDownloadAbortRequestSchema,
  DaemonVoiceOpenAiCompatDownloadAbortResponseSchema,
  DaemonVoiceOpenAiCompatDownloadChunkRequestSchema,
  DaemonVoiceOpenAiCompatDownloadChunkResponseSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatModelsListRequestSchema,
  DaemonVoiceOpenAiCompatRequestCancelRequestSchema,
  DaemonVoiceOpenAiCompatRequestCancelResponseSchema,
  DaemonVoiceOpenAiCompatSynthesizeRequestSchema,
  DaemonVoiceOpenAiCompatSynthesizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema,
  DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { configuration } from '@/configuration';
import {
  createTransferRecipientKeyPair,
  parseTransferRecipientPublicKeyBase64,
} from '@/machines/transfer/transferChunkEncryption';
import { createTransferSessionLifecycle } from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import type { OpenAiCompatVoiceClient } from '@/daemon/voice/openAiCompat/client';
import type { RpcHandlerRegistrar } from '../rpc/types';

const invalidParameters = Object.freeze({
  ok: false as const,
  errorCode: 'invalid_parameters' as const,
  error: 'invalid_parameters' as const,
  retryable: false,
});

const internalError = Object.freeze({
  ok: false as const,
  errorCode: 'internal_error' as const,
  error: 'internal_error' as const,
  retryable: false,
});

const transferInvalidParameters = Object.freeze({
  success: false as const,
  error: 'invalid_parameters' as const,
  errorCode: 'invalid_parameters' as const,
});

function transferFailure(code: 'transfer_not_found' | 'transfer_failed' | 'cancelled') {
  return Object.freeze({ success: false as const, error: code, errorCode: code });
}

type FinalizedUpload = Readonly<{
  path: string;
  sizeBytes: number;
  mimeType: 'audio/wav' | 'audio/mpeg' | 'audio/mp4' | 'audio/webm' | 'audio/ogg';
  fileName: string;
}>;

export type MachineVoiceOpenAiCompatRpcRegistration = Readonly<{
  dispose(): Promise<void>;
}>;

export function registerMachineVoiceOpenAiCompatRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  client: OpenAiCompatVoiceClient;
}>): MachineVoiceOpenAiCompatRpcRegistration {
  const ttlMs = Number.isFinite(configuration.filesTransferSessionTtlMs)
    ? Math.max(1_000, Math.trunc(configuration.filesTransferSessionTtlMs))
    : 60_000;
  const chunkSizeBytes = Math.min(
    DAEMON_VOICE_OPENAI_COMPAT_TRANSFER_CHUNK_MAX_BYTES,
    Math.max(1, Math.trunc(configuration.filesTransferChunkBytes)),
  );
  const uploadStore = new TransferSessionStore({ ttlMs });
  const downloadStore = new TransferSessionStore({ ttlMs });
  const uploads = createTransferSessionLifecycle({ store: uploadStore, chunkSizeBytes });
  const downloads = createTransferSessionLifecycle({ store: downloadStore, chunkSizeBytes });
  const uploadMetadata = new Map<string, Omit<FinalizedUpload, 'path'>>();
  const finalizedUploads = new Map<string, FinalizedUpload>();
  const finalizedUploadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const downloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let outputRootPromise: Promise<string> | null = null;
  let disposed = false;

  const outputRoot = async () => {
    outputRootPromise ??= mkdtemp(join(tmpdir(), 'happier-openai-compat-voice-'));
    return await outputRootPromise;
  };

  const clearUpload = async (uploadId: string, deleteFile = true): Promise<void> => {
    const timer = finalizedUploadTimers.get(uploadId);
    if (timer) clearTimeout(timer);
    finalizedUploadTimers.delete(uploadId);
    uploadMetadata.delete(uploadId);
    const finalized = finalizedUploads.get(uploadId);
    finalizedUploads.delete(uploadId);
    await uploads.abortUploadTransferSession({ uploadId }).catch(() => undefined);
    if (deleteFile && finalized?.path) await rm(finalized.path, { force: true }).catch(() => undefined);
  };

  const scheduleUploadExpiry = (uploadId: string): void => {
    const existingTimer = finalizedUploadTimers.get(uploadId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => { void clearUpload(uploadId); }, ttlMs);
    timer.unref?.();
    finalizedUploadTimers.set(uploadId, timer);
  };

  const clearDownload = async (downloadId: string): Promise<void> => {
    const timer = downloadTimers.get(downloadId);
    if (timer) clearTimeout(timer);
    downloadTimers.delete(downloadId);
    await downloads.abortDownloadTransferSession({ downloadId }).catch(() => undefined);
  };

  const scheduleDownloadExpiry = (downloadId: string): void => {
    const existingTimer = downloadTimers.get(downloadId);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => { void clearDownload(downloadId); }, ttlMs);
    timer.unref?.();
    downloadTimers.set(downloadId, timer);
  };

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_CHAT, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatChatRequestSchema.safeParse(raw);
    return parsed.success ? await params.client.chat(parsed.data) : invalidParameters;
  });
  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_MODELS_LIST, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatModelsListRequestSchema.safeParse(raw);
    return parsed.success ? await params.client.modelsList(parsed.data) : invalidParameters;
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_INIT, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatTranscribeUploadInitRequestSchema.safeParse(raw);
    if (!parsed.success || disposed) return transferInvalidParameters;
    try {
      const recipient = createTransferRecipientKeyPair();
      const session = await uploads.openUploadTransferSession({
        target: {
          destPath: 'openai-compat-transcribe',
          destDisplayPath: 'openai-compat-transcribe',
          expectedSizeBytes: parsed.data.sizeBytes,
          overwrite: true,
          finalizeUpload: async ({ tempPath, sizeBytes }) => ({ success: true, path: tempPath, sizeBytes }),
        },
        recipientSecretKeySeed: recipient.recipientSecretKeySeed,
        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
      });
      uploadMetadata.set(session.uploadId, {
        sizeBytes: parsed.data.sizeBytes,
        mimeType: parsed.data.mimeType,
        fileName: parsed.data.fileName,
      });
      scheduleUploadExpiry(session.uploadId);
      return DaemonVoiceOpenAiCompatTranscribeUploadInitResponseSchema.parse({
        success: true,
        uploadId: session.uploadId,
        chunkSizeBytes: session.chunkSizeBytes,
        recipientPublicKeyBase64: session.recipientPublicKeyBase64,
      });
    } catch {
      return transferFailure('transfer_failed');
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatTranscribeUploadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    const response = await uploads.writeUploadTransferChunk(parsed.data);
    if (response.success) {
      scheduleUploadExpiry(parsed.data.uploadId);
      return DaemonVoiceOpenAiCompatTranscribeUploadChunkResponseSchema.parse({ success: true });
    }
    return uploadMetadata.has(parsed.data.uploadId) ? transferFailure('transfer_failed') : transferFailure('transfer_not_found');
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatTranscribeUploadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    const metadata = uploadMetadata.get(parsed.data.uploadId);
    if (!metadata) return transferFailure('transfer_not_found');
    const result = await uploads.finalizeUploadTransferSession(parsed.data);
    if (!result.success) return transferFailure('transfer_failed');
    uploadMetadata.delete(parsed.data.uploadId);
    finalizedUploads.set(parsed.data.uploadId, {
      ...metadata,
      path: result.finalized.path,
      sizeBytes: result.finalized.sizeBytes,
    });
    scheduleUploadExpiry(parsed.data.uploadId);
    return DaemonVoiceOpenAiCompatTranscribeUploadFinalizeResponseSchema.parse({
      success: true,
      uploadId: parsed.data.uploadId,
      sizeBytes: result.finalized.sizeBytes,
      sha256: result.sha256,
    });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE_UPLOAD_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatTranscribeUploadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    await clearUpload(parsed.data.uploadId);
    return DaemonVoiceOpenAiCompatTranscribeUploadAbortResponseSchema.parse({ success: true });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_TRANSCRIBE, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatTranscribeRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParameters;
    const uploaded = finalizedUploads.get(parsed.data.uploadId);
    if (!uploaded) return invalidParameters;
    finalizedUploads.delete(parsed.data.uploadId);
    const timer = finalizedUploadTimers.get(parsed.data.uploadId);
    if (timer) clearTimeout(timer);
    finalizedUploadTimers.delete(parsed.data.uploadId);
    try {
      const bytes = new Uint8Array(await readFile(uploaded.path));
      const { uploadId: _uploadId, ...request } = parsed.data;
      return await params.client.transcribe({
        ...request,
        audio: {
          bytes,
          mimeType: uploaded.mimeType,
          fileName: uploaded.fileName,
        },
      });
    } catch {
      return internalError;
    } finally {
      await rm(uploaded.path, { force: true }).catch(() => undefined);
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_SYNTHESIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatSynthesizeRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParameters;
    try {
      parseTransferRecipientPublicKeyBase64(parsed.data.recipientPublicKeyBase64);
    } catch {
      return invalidParameters;
    }
    const { recipientPublicKeyBase64, ...request } = parsed.data;
    let filePath: string | null = null;
    try {
      const synthesized = await params.client.synthesize(request);
      if (!synthesized.ok) return synthesized;
      const root = await outputRoot();
      filePath = join(root, `${randomUUID()}.audio`);
      await writeFile(filePath, synthesized.bytes, { mode: 0o600 });
      const session = await downloads.openDownloadTransferSession({
        source: {
          filePath,
          deleteFileOnClose: true,
          sizeBytes: synthesized.bytes.byteLength,
          name: 'speech-audio',
        },
        recipientPublicKeyBase64,
      });
      scheduleDownloadExpiry(session.downloadId);
      return DaemonVoiceOpenAiCompatSynthesizeResponseSchema.parse({
        ok: true,
        downloadId: session.downloadId,
        chunkSizeBytes: session.chunkSizeBytes,
        sizeBytes: synthesized.bytes.byteLength,
        mimeType: synthesized.mimeType,
      });
    } catch {
      if (filePath) await rm(filePath, { force: true }).catch(() => undefined);
      return internalError;
    }
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_CHUNK, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatDownloadChunkRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    const response = await downloads.readDownloadTransferChunk(parsed.data);
    if (!response.success) return transferFailure('transfer_not_found');
    if (!('payloadBase64' in response)) return transferFailure('transfer_failed');
    scheduleDownloadExpiry(parsed.data.downloadId);
    return DaemonVoiceOpenAiCompatDownloadChunkResponseSchema.parse(response);
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_FINALIZE, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatDownloadFinalizeRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    if (!downloadStore.getDownloadSession(parsed.data.downloadId)) return transferFailure('transfer_not_found');
    await downloads.finalizeDownloadTransferSession(parsed.data);
    const timer = downloadTimers.get(parsed.data.downloadId);
    if (timer) clearTimeout(timer);
    downloadTimers.delete(parsed.data.downloadId);
    return DaemonVoiceOpenAiCompatDownloadFinalizeResponseSchema.parse({ success: true });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_DOWNLOAD_ABORT, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatDownloadAbortRequestSchema.safeParse(raw);
    if (!parsed.success) return transferInvalidParameters;
    await clearDownload(parsed.data.downloadId);
    return DaemonVoiceOpenAiCompatDownloadAbortResponseSchema.parse({ success: true });
  });

  params.rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_VOICE_OPENAI_COMPAT_REQUEST_CANCEL, async (raw: unknown) => {
    const parsed = DaemonVoiceOpenAiCompatRequestCancelRequestSchema.safeParse(raw);
    if (!parsed.success) return invalidParameters;
    return DaemonVoiceOpenAiCompatRequestCancelResponseSchema.parse({
      ok: true,
      cancelled: params.client.cancel(parsed.data.requestId),
    });
  });

  return Object.freeze({
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of finalizedUploadTimers.values()) clearTimeout(timer);
      for (const timer of downloadTimers.values()) clearTimeout(timer);
      finalizedUploadTimers.clear();
      downloadTimers.clear();
      await Promise.all([
        ...[...finalizedUploads.values()].map(async (upload) => await rm(upload.path, { force: true }).catch(() => undefined)),
        uploadStore.dispose(),
        downloadStore.dispose(),
      ]);
      uploadMetadata.clear();
      finalizedUploads.clear();
      if (outputRootPromise) await rm(await outputRootPromise, { recursive: true, force: true }).catch(() => undefined);
    },
  });
}
