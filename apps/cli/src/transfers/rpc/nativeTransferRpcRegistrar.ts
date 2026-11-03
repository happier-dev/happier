import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { NativeTransferSessionOwner, TransferSessionStore } from '@happier-dev/transfers/node';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { FilesystemEffectFailure } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';

export type PrepareNativeFilesystemTransfer = (context?: RpcHandlerContext) => Promise<NativeTransferSessionOwner | null>;

/** The existing store retains one native descriptor/process across the raw
 * transfer phases. Fresh ingress admission stays at the host; the retained
 * verifyInvocation port only compares that admitted caller with original custody. */
export function createNativeFilesystemTransferRpcRegistrar(registrar: RpcHandlerRegistrar, params: Readonly<{
  store: TransferSessionStore; direction: 'upload' | 'download';
  prepareNativeTransfer: PrepareNativeFilesystemTransfer;
  fallbackAdmission?: (context?: RpcHandlerContext) => Promise<FilesystemEffectFailure | null>;
}>): RpcHandlerRegistrar {
  const methods = params.direction === 'upload'
    ? { init: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, chunk: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, abort: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT }
    : { init: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, chunk: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, abort: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT };
  const idKey = params.direction === 'upload' ? 'uploadId' : 'downloadId';
  const resultSchema = z.object({ success: z.boolean(), uploadId: z.optional(z.string()), downloadId: z.optional(z.string()) });
  const close = async (sessionId: string) => {
    if (params.direction === 'upload') await params.store.abortUploadSession(sessionId);
    else await params.store.closeDownloadSession(sessionId);
  };
  const refresh = (sessionId: string) => {
    if (params.direction === 'upload') params.store.refreshUploadExpiry(sessionId);
    else params.store.refreshDownloadExpiry(sessionId);
  };
  const failure = (error: unknown) => ({ success: false,
    errorCode: error instanceof Error && error.name === 'AbortError' ? 'cancelled'
      : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code : 'filesystem_identity_custody_unavailable',
    error: 'Native filesystem transfer is unavailable',
  });
  return { registerHandler(method, handler) {
    registrar.registerHandler(method, async (input, context) => {
      params.store.cleanupExpiredBestEffort();
      try {
        context?.signal.throwIfAborted();
        if (method === methods.init) {
          const native = await params.prepareNativeTransfer(context);
          if (native) {
            let retained = false;
            try {
              await native.verifyInvocation(context);
              const response = await native.invoke(method, input);
              const parsed = resultSchema.parse(response);
              if (parsed.success) {
                const sessionId = parsed[idKey];
                if (!sessionId) throw new Error('Native transfer did not produce its session id');
                params.store.retainNativeSession(params.direction, sessionId, native);
                retained = true;
              }
              return response;
            } finally { if (!retained) await native.dispose(); }
          }
        } else {
          const rawId: unknown = input && typeof input === 'object' ? Reflect.get(input, idKey) : undefined;
          const sessionId = typeof rawId === 'string' ? rawId : '';
          const retained = params.store.beginNativeSessionOperation(params.direction, sessionId);
          if (retained) {
            try {
              await retained.owner.verifyInvocation(context);
              const response = await retained.owner.invoke(method, input);
              const parsed = resultSchema.parse(response);
              if (parsed.success && (method === methods.finalize || method === methods.abort)) await close(sessionId);
              else refresh(sessionId);
              return response;
            } finally { retained.release(); }
          }
          const local = params.direction === 'upload' ? params.store.getUploadSession(sessionId) : params.store.getDownloadSession(sessionId);
          // No descriptor exists: preserve incumbent missing/idempotent replies
          // without re-entering requester/Home/native preparation per phase.
          if (!local) return await handler(input, context);
        }
        const refused = await params.fallbackAdmission?.(context);
        return refused ? { success: false, ...refused } : await handler(input, context);
      } catch (error) { return failure(error); }
    });
  } };
}
