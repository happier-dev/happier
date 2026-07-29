import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferPathAllowanceRegistry } from '../targets/createTransferPathAllowanceRegistry';
import {
  resolveTransferUploadInitTarget,
  type NonPromptTransferUploadInitRequest,
  type TransferUploadInitRequest,
} from '../targets/resolveTransferUploadInitTarget';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';

type TransferUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
  | Readonly<{ success: false; error: string }>;

type TransferUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string }>;

export function registerTransferUploadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    store: TransferSessionStore;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
    attachmentUpload?: Readonly<{
      pathAllowanceRegistry: TransferPathAllowanceRegistry;
    }>;
  }>,
): void {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());

  registerUploadTransferLifecycleHandlers<TransferUploadInitResponse, TransferUploadFinalizeResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as TransferUploadInitRequest | null;
      if (!request || typeof request !== 'object') {
        return { kind: 'rejected', response: { success: false, error: 'Invalid request' } };
      }

      const requestKind = request.t ?? 'session_file_upload_v1';
      if (request.t === 'prompt_asset_upload_v1') {
        return { kind: 'rejected', response: { success: false, error: 'Unknown upload request type' } };
      }
      if (requestKind === 'session_attachment_upload_v1' && !deps.attachmentUpload) {
        return { kind: 'rejected', response: { success: false, error: 'Attachment uploads are unavailable' } };
      }

      const uploadRequest: NonPromptTransferUploadInitRequest = request;

      const resolved = await resolveTransferUploadInitTarget({
        workingDirectory: deps.workingDirectory,
        accessPolicy: deps.accessPolicy,
        request: uploadRequest,
        tempUploadRoot,
        additionalAllowedWriteDirs: deps.getAdditionalAllowedWriteDirs?.(),
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
        ...(deps.attachmentUpload ? { attachmentUpload: deps.attachmentUpload } : {}),
      });
      if (!resolved.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: resolved.error },
        };
      }

      return {
        kind: 'accepted',
        target: resolved.target,
        sha256Expected: resolved.sha256Expected,
        diagnosticContext: resolved.diagnosticContext,
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
