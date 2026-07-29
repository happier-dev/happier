import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createTransferRecipientKeyPair } from '@/machines/transfer/transferChunkEncryption';
import { logger } from '@/ui/logger';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { UploadTransferTarget } from '../targets/uploadTransferTarget';
import {
  createTransferSessionLifecycle,
  openUploadTransferSession,
  writeUploadTransferChunk,
  finalizeUploadTransferSession,
  abortUploadTransferSession,
} from '../core/transferSessionLifecycle';
import {
  buildTransferLifecycleDiagnosticFields,
  type TransferLifecycleDiagnosticContext,
} from './transferLifecycleDiagnostics';

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
      diagnosticContext: TransferLifecycleDiagnosticContext;
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
  maxEncryptedDataKeyEnvelopeBytes?: number;
}>): void {
  const lifecycle = createTransferSessionLifecycle({
    store: params.store,
    chunkSizeBytes: configuration.filesTransferChunkBytes,
  });

  params.rpcHandlerManager.registerHandler(params.methods.init, async (data: unknown): Promise<TInitResponse> => {
    params.store.cleanupExpiredBestEffort();
    const resolved = await params.resolveInit(data);
    if (resolved.kind === 'rejected') {
      return resolved.response;
    }

    const recipientKeyPair = params.enableChunkEncryption
      ? createTransferRecipientKeyPair()
      : null;
    const session = await openUploadTransferSession({
      lifecycle,
      target: resolved.target,
      sha256Expected: resolved.sha256Expected,
      ...(recipientKeyPair
        ? {
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
          }
        : {}),
    });

    logger.debug('[TRANSFER] upload lifecycle', {
      code: 'transfer_upload_initialized',
      sizeBytes: resolved.target.expectedSizeBytes,
      chunkSizeBytes: session.chunkSizeBytes,
      ...buildTransferLifecycleDiagnosticFields(resolved.diagnosticContext),
    });

    return params.buildInitSuccessResponse({ session });
  });

  params.rpcHandlerManager.registerHandler<UploadChunkRequest, UploadChunkResponse>(params.methods.chunk, async (data) => {
    return await writeUploadTransferChunk({
      lifecycle,
      uploadId: typeof data?.uploadId === 'string' ? data.uploadId : '',
      index: typeof data?.index === 'number' ? data.index : Number(data?.index),
      contentBase64: typeof data?.contentBase64 === 'string' ? data.contentBase64 : undefined,
      payloadBase64: typeof data?.payloadBase64 === 'string' ? data.payloadBase64 : undefined,
      encryptedDataKeyEnvelopeBase64: typeof data?.encryptedDataKeyEnvelopeBase64 === 'string'
        ? data.encryptedDataKeyEnvelopeBase64
        : undefined,
    });
  });

  params.rpcHandlerManager.registerHandler(params.methods.finalize, async (data: unknown): Promise<TFinalizeResponse> => {
    const uploadId = typeof (data as { uploadId?: unknown } | null)?.uploadId === 'string'
      ? (data as { uploadId: string }).uploadId
      : '';
    if (!uploadId) {
      return params.buildFinalizeMissingUploadIdResponse();
    }

    const finalized = await finalizeUploadTransferSession({
      lifecycle,
      uploadId,
    });
    if (!finalized.success) {
      if (finalized.error === 'Upload session not found') {
        return params.buildFinalizeMissingSessionResponse();
      }
      if (finalized.error === 'Upload is incomplete') {
        return params.buildFinalizeSizeMismatchResponse();
      }
      if (finalized.error === 'Upload hash mismatch') {
        return params.buildFinalizeHashMismatchResponse();
      }
      return params.buildFinalizeFailureResponse(finalized.error);
    }

    return params.buildFinalizeSuccessResponse({
      finalized: finalized.finalized,
      sha256: finalized.sha256,
    });
  });

  params.rpcHandlerManager.registerHandler<UploadAbortRequest, UploadAbortResponse>(params.methods.abort, async (data) => {
    const uploadId = typeof data?.uploadId === 'string' ? data.uploadId : '';
    if (!uploadId) return { success: false, error: 'Missing uploadId' };
    await abortUploadTransferSession({ lifecycle, uploadId });
    return { success: true };
  });
}
