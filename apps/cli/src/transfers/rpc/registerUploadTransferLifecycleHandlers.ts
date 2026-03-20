import { createHash } from 'crypto';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import {
  createTransferRecipientKeyPair,
  decryptEncryptedTransferChunkEnvelope,
} from '@/machines/transfer/transferChunkEncryption';
import { logger } from '@/ui/logger';

import { decodeUploadChunkBase64 } from '../core/decodeUploadChunkBase64';
import { TransferSessionStore } from '../core/transferSessionStore';
import type { UploadTransferTarget } from '../targets/uploadTransferTarget';

type UploadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getUploadSession']>>;

type UploadChunkRequest = Readonly<{
  uploadId: string;
  index: number;
  contentBase64?: string;
  payloadBase64?: string;
  encryptedDataKeyEnvelopeBase64?: string;
}>;

type UploadChunkResponse = Readonly<{ success: true } | { success: false; error: string }>;

type UploadAbortRequest = Readonly<{ uploadId: string }>;
type UploadAbortResponse = Readonly<{ success: true } | { success: false; error: string }>;

type UploadTransferSessionTarget<TFinalizeResult> = UploadTransferTarget<TFinalizeResult> & Readonly<{
  destPath: string;
}>;

type ResolvedUploadInit<TInitResponse, TFinalizeResult> =
  | Readonly<{ kind: 'rejected'; response: TInitResponse }>
  | Readonly<{
      kind: 'accepted';
      target: UploadTransferSessionTarget<TFinalizeResult>;
      sha256Expected?: string;
      logContext?: Record<string, unknown>;
    }>;

export function registerUploadTransferLifecycleHandlers<TInitResponse, TFinalizeResponse, TFinalizeResult = undefined>(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  store: TransferSessionStore;
  methods: Readonly<{
    init: string;
    chunk: string;
    finalize: string;
    abort: string;
  }>;
  resolveInit: (data: unknown) => Promise<ResolvedUploadInit<TInitResponse, TFinalizeResult>> | ResolvedUploadInit<TInitResponse, TFinalizeResult>;
  buildInitSuccessResponse: (input: Readonly<{
    session: UploadSessionHandle;
  }>) => TInitResponse;
  buildFinalizeMissingUploadIdResponse: () => TFinalizeResponse;
  buildFinalizeMissingSessionResponse: () => TFinalizeResponse;
  buildFinalizeSizeMismatchResponse: () => TFinalizeResponse;
  buildFinalizeHashMismatchResponse: () => TFinalizeResponse;
  buildFinalizeErrorResponse: (error: unknown) => TFinalizeResponse;
  buildFinalizeFailureResponse: (error: string) => TFinalizeResponse;
  buildFinalizeSuccessResponse: (input: Readonly<{
    finalized: Readonly<{ path: string; sizeBytes: number; result?: unknown }>;
    sha256: string;
  }>) => TFinalizeResponse;
  enableChunkEncryption?: boolean;
}>): void {
  params.rpcHandlerManager.registerHandler(params.methods.init, async (data: unknown): Promise<TInitResponse> => {
    params.store.cleanupExpiredBestEffort();
    const resolved = await params.resolveInit(data);
    if (resolved.kind === 'rejected') {
      return resolved.response;
    }

    const chunkSizeBytes = configuration.filesTransferChunkBytes;
    const recipientKeyPair = params.enableChunkEncryption === true ? createTransferRecipientKeyPair() : null;
    const session = await params.store.createUploadSession({
      destPath: resolved.target.destPath,
      destDisplayPath: resolved.target.destDisplayPath,
      overwrite: resolved.target.overwrite,
      expectedSizeBytes: resolved.target.expectedSizeBytes,
      finalizeUpload: resolved.target.finalizeUpload,
      chunkSizeBytes,
      sha256Expected: resolved.sha256Expected,
      recipientSecretKeySeed: recipientKeyPair?.recipientSecretKeySeed,
      recipientPublicKeyBase64: recipientKeyPair?.recipientPublicKeyBase64,
      hash: createHash('sha256'),
    });

    if (resolved.logContext) {
      logger.debug('Transfer upload init:', {
        uploadId: session.uploadId,
        sizeBytes: resolved.target.expectedSizeBytes,
        chunkSizeBytes,
        ...resolved.logContext,
      });
    }

    return params.buildInitSuccessResponse({ session });
  });

  params.rpcHandlerManager.registerHandler<UploadChunkRequest, UploadChunkResponse>(params.methods.chunk, async (data) => {
    params.store.cleanupExpiredBestEffort();
    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    const index = typeof data?.index === 'number' ? data.index : Number(data?.index);
    const contentBase64 = typeof data?.contentBase64 === 'string' ? data.contentBase64 : '';
    const payloadBase64 = typeof data?.payloadBase64 === 'string' ? data.payloadBase64 : '';
    const encryptedDataKeyEnvelopeBase64 = typeof data?.encryptedDataKeyEnvelopeBase64 === 'string'
      ? data.encryptedDataKeyEnvelopeBase64
      : '';

    if (!uploadId) return { success: false, error: 'Missing uploadId' };
    if (!Number.isFinite(index) || index < 0) return { success: false, error: 'Invalid index' };

    const session = params.store.getUploadSession(uploadId);
    if (!session) return { success: false, error: 'Upload session not found' };
    if (index !== session.nextIndex) return { success: false, error: 'Unexpected chunk index' };
    let buffer: Buffer;
    if (session.recipientSecretKeySeed) {
      if (!payloadBase64) return { success: false, error: 'Missing payloadBase64' };
      if (!encryptedDataKeyEnvelopeBase64) return { success: false, error: 'Missing encryptedDataKeyEnvelopeBase64' };
      try {
        buffer = decryptEncryptedTransferChunkEnvelope({
          transferId: uploadId,
          sequence: index,
          payloadBase64,
          encryptedDataKeyEnvelopeBase64,
          recipientSecretKeySeed: session.recipientSecretKeySeed,
        });
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : `Failed to decrypt transfer chunk for ${uploadId}` };
      }
    } else {
      if (!contentBase64) return { success: false, error: 'Missing contentBase64' };
      const decodedBuffer = decodeUploadChunkBase64(contentBase64);
      if (!decodedBuffer) {
        return { success: false, error: 'Invalid base64 content' };
      }
      buffer = decodedBuffer;
    }
    if (buffer.length > session.chunkSizeBytes) {
      return { success: false, error: 'Chunk exceeds configured chunk size' };
    }
    if (session.receivedBytes + buffer.length > session.expectedSizeBytes) {
      return { success: false, error: 'Chunk exceeds expected upload size' };
    }

    try {
      await session.file.write(buffer);
      session.hash.update(buffer);
      session.receivedBytes += buffer.length;
      session.nextIndex += 1;
      params.store.refreshUploadExpiry(uploadId);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write chunk' };
    }
  });

  params.rpcHandlerManager.registerHandler(params.methods.finalize, async (data: unknown): Promise<TFinalizeResponse> => {
    params.store.cleanupExpiredBestEffort();
    const uploadId = typeof (data as { uploadId?: unknown } | null)?.uploadId === 'string'
      ? (data as { uploadId: string }).uploadId
      : '';
    if (!uploadId) {
      return params.buildFinalizeMissingUploadIdResponse();
    }

    const session = params.store.getUploadSession(uploadId);
    if (!session) {
      return params.buildFinalizeMissingSessionResponse();
    }
    if (session.receivedBytes !== session.expectedSizeBytes) {
      return params.buildFinalizeSizeMismatchResponse();
    }

    const sha256 = session.hash.copy().digest('hex');
    if (session.sha256Expected && session.sha256Expected !== sha256) {
      await params.store.abortUploadSession(uploadId);
      return params.buildFinalizeHashMismatchResponse();
    }

    try {
      await session.file.close().catch(() => undefined);
      const finalized = await session.finalizeUpload({
        tempPath: session.tempPath,
        sizeBytes: session.expectedSizeBytes,
        sha256,
      });
      if (!finalized.success) {
        return params.buildFinalizeFailureResponse(finalized.error);
      }

      await params.store.finalizeUploadSession(uploadId);
      return params.buildFinalizeSuccessResponse({
        finalized,
        sha256,
      });
    } catch (error) {
      await params.store.abortUploadSession(uploadId);
      return params.buildFinalizeErrorResponse(error);
    }
  });

  params.rpcHandlerManager.registerHandler<UploadAbortRequest, UploadAbortResponse>(params.methods.abort, async (data) => {
    params.store.cleanupExpiredBestEffort();
    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    if (!uploadId) return { success: false, error: 'Missing uploadId' };
    await params.store.abortUploadSession(uploadId);
    return { success: true };
  });
}
