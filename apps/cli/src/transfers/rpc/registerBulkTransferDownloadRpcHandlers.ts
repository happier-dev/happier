import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { parseTransferRecipientPublicKeyBase64 } from '@/machines/transfer/transferChunkEncryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import { resolveWorkspaceFileDownloadSource } from '../targets/resolveWorkspaceFileDownloadSource';
import { registerDownloadTransferLifecycleHandlers } from './registerDownloadTransferLifecycleHandlers';

type BulkTransferDownloadInitRequest = Readonly<{
  t: 'session_file_download_v1';
  path: string;
  asZip?: boolean;
  recipientPublicKeyBase64?: string;
}>;

type BulkTransferDownloadInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string }>;

export function registerBulkTransferDownloadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    store: TransferSessionStore;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
  }>,
): void {
  registerDownloadTransferLifecycleHandlers<BulkTransferDownloadInitResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as BulkTransferDownloadInitRequest | null;
      if (!request || request.t !== 'session_file_download_v1') {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Invalid request',
          },
        };
      }

      const recipientPublicKeyBase64 = typeof request.recipientPublicKeyBase64 === 'string'
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
      try {
        // Validate early so init fails closed instead of crashing later during chunk encryption.
        parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
      } catch (error) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid recipientPublicKeyBase64',
          },
        };
      }
      const source = await resolveWorkspaceFileDownloadSource({
        workingDirectory: deps.workingDirectory,
        path: request.path,
        asZip: request.asZip,
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
          path: request.path,
          asZip: Boolean(request.asZip),
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
