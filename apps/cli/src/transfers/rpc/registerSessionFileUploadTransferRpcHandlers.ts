import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import { resolveWorkspaceFileUploadTarget } from '../targets/resolveWorkspaceFileUploadTarget';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';

type SessionFileUploadInitRequest = Readonly<{
  path: string;
  sizeBytes: number;
  overwrite?: boolean;
  sha256?: string;
}>;

type SessionFileUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
  | Readonly<{ success: false; error: string }>;

type SessionFileUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string }>;

export function registerSessionFileUploadTransferRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    store: TransferSessionStore;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
  }>,
): void {
  registerUploadTransferLifecycleHandlers<SessionFileUploadInitResponse, SessionFileUploadFinalizeResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as SessionFileUploadInitRequest | null;
      const target = resolveWorkspaceFileUploadTarget({
        workingDirectory: deps.workingDirectory,
        path: request?.path,
        sizeBytes: request?.sizeBytes,
        overwrite: request?.overwrite,
        additionalAllowedWriteDirs: deps.getAdditionalAllowedWriteDirs?.(),
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
      });
      if (!target.success) {
        return { kind: 'rejected', response: target };
      }
      const sha256Expected = typeof request?.sha256 === 'string' && request.sha256.trim() ? request.sha256.trim() : undefined;
      return {
        kind: 'accepted',
        target: target.target,
        sha256Expected,
        logContext: {
          path: typeof request?.path === 'string' ? request.path : '',
        },
      };
    },
    buildInitSuccessResponse: ({ session }) => ({
      success: true,
      uploadId: session.uploadId,
      chunkSizeBytes: session.chunkSizeBytes,
      recipientPublicKeyBase64: session.recipientPublicKeyBase64 ?? '',
    }),
    buildFinalizeMissingUploadIdResponse: () => ({ success: false, error: 'Missing uploadId' }),
    buildFinalizeMissingSessionResponse: () => ({ success: false, error: 'Upload session not found' }),
    buildFinalizeSizeMismatchResponse: () => ({ success: false, error: 'Upload size mismatch' }),
    buildFinalizeHashMismatchResponse: () => ({ success: false, error: 'Upload hash mismatch' }),
    buildFinalizeErrorResponse: (error) => ({ success: false, error: error instanceof Error ? error.message : 'Upload finalize failed' }),
    buildFinalizeFailureResponse: (error) => ({ success: false, error }),
    buildFinalizeSuccessResponse: ({ finalized, sha256 }) => ({
      success: true,
      path: finalized.path,
      sizeBytes: finalized.sizeBytes,
      sha256,
    }),
    enableChunkEncryption: true,
  });
}
