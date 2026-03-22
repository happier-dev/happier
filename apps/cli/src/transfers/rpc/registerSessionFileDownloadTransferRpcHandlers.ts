import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import { resolveWorkspaceFileDownloadSource } from '../targets/resolveWorkspaceFileDownloadSource';
import { registerDownloadTransferLifecycleHandlers } from './registerDownloadTransferLifecycleHandlers';

type SessionFileDownloadInitRequest = Readonly<{
  path: string;
  asZip?: boolean;
  recipientPublicKeyBase64?: string;
}>;

type SessionFileDownloadInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string }>;

export function registerSessionFileDownloadTransferRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    store: TransferSessionStore;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
  }>,
): void {
  registerDownloadTransferLifecycleHandlers<SessionFileDownloadInitResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as SessionFileDownloadInitRequest | null;
      const recipientPublicKeyBase64 = typeof request?.recipientPublicKeyBase64 === 'string'
        ? request.recipientPublicKeyBase64.trim()
        : '';
      if (!recipientPublicKeyBase64) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Missing recipientPublicKeyBase64',
          },
        };
      }
      const source = await resolveWorkspaceFileDownloadSource({
        workingDirectory: deps.workingDirectory,
        path: request?.path,
        asZip: request?.asZip,
        additionalAllowedReadDirs: deps.getAdditionalAllowedReadDirs?.(),
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
      });
      if (!source.success) {
        return { kind: 'rejected', response: source };
      }
      return {
        kind: 'accepted',
        source: source.source,
        recipientPublicKeyBase64,
        logContext: {
          path: typeof request?.path === 'string' ? request.path : '',
          asZip: Boolean(request?.asZip),
        },
      };
    },
    buildInitSuccessResponse: ({ session, source }) => ({
      success: true,
      downloadId: session.downloadId,
      chunkSizeBytes: session.chunkSizeBytes,
      sizeBytes: source.sizeBytes,
      name: source.name,
    }),
    buildInitErrorResponse: (error) => ({ success: false, error: error instanceof Error ? error.message : 'Download init failed' }),
  });
}
