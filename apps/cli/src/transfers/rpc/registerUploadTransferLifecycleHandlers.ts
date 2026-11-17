import type { RpcHandlerContext, RpcHandlerInvoker, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { logger } from '@/ui/logger';
import { carryActionFailureDiagnostic, readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';

import { TransferSessionStore } from '@happier-dev/transfers/node';
import type { UploadTransferTarget } from '@happier-dev/transfers/node';
import {
  createTransferSessionLifecycle,
  openUploadTransferSession,
  writeUploadTransferChunk,
  finalizeUploadTransferSession,
  abortUploadTransferSession,
} from '@happier-dev/transfers/node';
import {
  buildTransferLifecycleDiagnosticFields,
  type TransferLifecycleDiagnosticContext,
} from './transferLifecycleDiagnostics';

type UploadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getUploadSession']>>;

type UploadChunkResponse = Readonly<{ success: true } | { success: false; error: string }>;

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
  resolveInit: (data: unknown, context?: RpcHandlerContext) => Promise<ResolvedUploadInit<TInitResponse, TFinalizeResult>> | ResolvedUploadInit<TInitResponse, TFinalizeResult>;
  buildInitSuccessResponse: (input: Readonly<{
    session: UploadSessionHandle;
  }>) => TInitResponse;
  buildFinalizeMissingUploadIdResponse: () => TFinalizeResponse;
  buildFinalizeMissingSessionResponse: () => TFinalizeResponse;
  buildFinalizeSizeMismatchResponse: () => TFinalizeResponse;
  buildFinalizeHashMismatchResponse: () => TFinalizeResponse;
  buildFinalizeErrorResponse: (error: unknown) => TFinalizeResponse;
  buildFinalizeFailureResponse: (error: string, errorCode?: string, expiresAt?: number) => TFinalizeResponse;
  buildFinalizeSuccessResponse: (input: Readonly<{
    finalized: Readonly<{ path: string; sizeBytes: number; result?: unknown }>;
    sha256: string;
    uploadId: string;
  }>) => TFinalizeResponse;
  enableChunkEncryption?: boolean;
  maxEncryptedDataKeyEnvelopeBytes?: number;
}>): RpcHandlerInvoker {
  const lifecycle = createTransferSessionLifecycle({
    store: params.store,
    chunkSizeBytes: configuration.filesTransferChunkBytes,
  });

  const init = async (data: unknown, context?: RpcHandlerContext): Promise<TInitResponse> => {
    params.store.cleanupExpiredBestEffort();
    const resolved = await params.resolveInit(data, context);
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
  };

  const chunk = async (raw: unknown): Promise<UploadChunkResponse> => {
    const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    const result = await writeUploadTransferChunk({
      lifecycle,
      uploadId: typeof data?.uploadId === 'string' ? data.uploadId : '',
      index: typeof data?.index === 'number' ? data.index : Number(data?.index),
      contentBase64: typeof data?.contentBase64 === 'string' ? data.contentBase64 : undefined,
      payloadBase64: typeof data?.payloadBase64 === 'string' ? data.payloadBase64 : undefined,
      encryptedDataKeyEnvelopeBase64: typeof data?.encryptedDataKeyEnvelopeBase64 === 'string'
        ? data.encryptedDataKeyEnvelopeBase64
        : undefined,
    });
    const cause = readActionOutputDiagnostic(result)?.failureCause;
    if (cause) logger.warnLocalFile('[TRANSFER] Upload chunk write failed', cause);
    return result;
  };

  const finalize = async (data: unknown): Promise<TFinalizeResponse> => {
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
      const response = params.buildFinalizeFailureResponse(finalized.error, finalized.errorCode, params.store.getUploadSession(uploadId)?.expiresAt);
      const cause = readActionOutputDiagnostic(finalized)?.failureCause;
      if (cause) logger.warnLocalFile('[TRANSFER] Upload finalization failed', cause);
      return response !== null && typeof response === 'object' ? carryActionFailureDiagnostic(response, finalized) : response;
    }

    return params.buildFinalizeSuccessResponse({
      finalized: finalized.finalized,
      sha256: finalized.sha256,
      uploadId,
    });
  };

  const abort = async (data: unknown): Promise<UploadAbortResponse> => {
    const uploadId = data && typeof data === 'object' && 'uploadId' in data && typeof data.uploadId === 'string'
      ? data.uploadId : '';
    if (!uploadId) return { success: false, error: 'Missing uploadId' };
    await abortUploadTransferSession({ lifecycle, uploadId });
    return { success: true };
  };

  params.rpcHandlerManager.registerHandler(params.methods.init, init);
  params.rpcHandlerManager.registerHandler(params.methods.chunk, chunk);
  params.rpcHandlerManager.registerHandler(params.methods.finalize, finalize);
  params.rpcHandlerManager.registerHandler(params.methods.abort, abort);

  // Host callers retain this same lifecycle, not the public Machine method
  // table: daemon startup binds prepared-transfer envelopes to those method ids.
  return {
    async invokeLocal(method, data, options) {
      options?.signal?.throwIfAborted();
      if (method === params.methods.init) return await init(data);
      if (method === params.methods.chunk) return await chunk(data);
      if (method === params.methods.finalize) return await finalize(data);
      if (method === params.methods.abort) return await abort(data);
      throw new Error('Unknown local upload lifecycle method');
    },
  };
}
