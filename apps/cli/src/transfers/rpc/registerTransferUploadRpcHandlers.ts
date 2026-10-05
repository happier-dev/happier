import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';
import { sanitizeAttachmentFileName } from '../targets/resolveAttachmentTransferTarget';

import { TransferSessionStore } from '@happier-dev/transfers/node';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import {
  resolveTransferUploadInitTarget,
  type NonPromptTransferUploadInitRequest,
  type TransferUploadInitRequest,
  type TransferUploadInitAttachmentDeps,
} from '../targets/resolveTransferUploadInitTarget';
import type { ComposerMediaStageUploadTargetDeps } from '../targets/resolveComposerMediaStageUploadTarget';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';

type TransferUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string; expiresAt?: number }>
  | Readonly<{ success: false; error: string }>;

type TransferUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; result?: unknown; attachmentHandle?: SessionAttachmentHandleV1 }>
  | Readonly<{ success: false; error: string; errorCode?: string; expiresAt?: number }>;

export function registerTransferUploadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    store: TransferSessionStore;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
    attachmentUpload?: TransferUploadInitAttachmentDeps;
    composerMediaStage?: ComposerMediaStageUploadTargetDeps;
    /** Immutable Session namespace: only attachments are accepted, never caller paths. */
    sessionAttachment?: Readonly<{ sessionId: string }>;
  }>,
): void {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());

  registerUploadTransferLifecycleHandlers<TransferUploadInitResponse, TransferUploadFinalizeResponse, unknown>({
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
      if (deps.sessionAttachment && requestKind !== 'session_attachment_upload_v1') {
        return { kind: 'rejected', response: { success: false, error: 'Only Session attachment uploads are available' } };
      }
      if (deps.sessionAttachment && request.t === 'session_attachment_upload_v1'
        && request.sessionId !== deps.sessionAttachment.sessionId) {
        return { kind: 'rejected', response: { success: false, error: 'Attachment Session does not match the hosted Session' } };
      }
      if (request.t === 'prompt_asset_upload_v1') {
        return { kind: 'rejected', response: { success: false, error: 'Unknown upload request type' } };
      }
      if (requestKind === 'session_attachment_upload_v1' && !deps.attachmentUpload) {
        return { kind: 'rejected', response: { success: false, error: 'Attachment uploads are unavailable' } };
      }
      if (requestKind === 'composer_media_stage_upload_v1' && !deps.composerMediaStage) {
        return { kind: 'rejected', response: { success: false, error: 'Composer media staging is unavailable' } };
      }

      const uploadRequest: NonPromptTransferUploadInitRequest = deps.sessionAttachment && request.t === 'session_attachment_upload_v1'
        ? {
            t: request.t,
            sessionId: deps.sessionAttachment.sessionId,
            messageLocalId: request.messageLocalId,
            fileName: request.fileName,
            sizeBytes: request.sizeBytes,
            uploadLocation: request.uploadLocation,
            workspaceRelativeDir: request.workspaceRelativeDir,
            vcsIgnoreStrategy: request.vcsIgnoreStrategy,
            vcsIgnoreWritesEnabled: request.vcsIgnoreWritesEnabled,
          }
        : request;

      const resolved = await resolveTransferUploadInitTarget({
        workingDirectory: deps.workingDirectory,
        accessPolicy: deps.accessPolicy,
        request: uploadRequest,
        tempUploadRoot,
        additionalAllowedWriteDirs: deps.getAdditionalAllowedWriteDirs?.(),
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
        ...(deps.attachmentUpload ? { attachmentUpload: deps.attachmentUpload } : {}),
        ...(deps.composerMediaStage ? { composerMediaStage: deps.composerMediaStage } : {}),
      });
      if (!resolved.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: resolved.error },
        };
      }

      return {
        kind: 'accepted',
        target: deps.sessionAttachment && uploadRequest.t === 'session_attachment_upload_v1'
          ? {
              ...resolved.target,
              finalizeUpload: async (input) => {
                const finalized = await resolved.target.finalizeUpload(input);
                if (finalized.success) {
                  deps.store.issueAttachment({
                    uploadId: input.uploadId,
                    sessionId: deps.sessionAttachment!.sessionId,
                    filePath: resolved.target.destPath,
                    name: sanitizeAttachmentFileName(String(uploadRequest.fileName)),
                  });
                }
                return finalized;
              },
            }
          : resolved.target,
        sha256Expected: resolved.sha256Expected,
        diagnosticContext: resolved.diagnosticContext,
      };
    },
    buildInitSuccessResponse: ({ session }) => ({
      success: true,
      uploadId: session.uploadId,
      chunkSizeBytes: session.chunkSizeBytes,
      recipientPublicKeyBase64: session.recipientPublicKeyBase64 ?? '',
      ...(deps.sessionAttachment ? { expiresAt: session.expiresAt } : {}),
    }),
    buildFinalizeMissingUploadIdResponse: () => ({ success: false, error: 'Missing uploadId' }),
    buildFinalizeMissingSessionResponse: () => ({ success: false, error: 'Upload session not found' }),
    buildFinalizeSizeMismatchResponse: () => ({ success: false, error: 'Upload size mismatch' }),
    buildFinalizeHashMismatchResponse: () => ({ success: false, error: 'Upload hash mismatch' }),
    buildFinalizeErrorResponse: (error) => ({ success: false, error: error instanceof Error ? error.message : 'Upload finalize failed' }),
    buildFinalizeFailureResponse: (error, errorCode, expiresAt) => ({ success: false, error, ...(errorCode ? { errorCode, expiresAt } : {}) }),
    buildFinalizeSuccessResponse: ({ finalized, sha256, uploadId }) => ({
      success: true,
      path: finalized.path,
      sizeBytes: finalized.sizeBytes,
      sha256,
      ...(finalized.result === undefined ? {} : { result: finalized.result }),
      ...(deps.sessionAttachment ? { attachmentHandle: { v: 1 as const, sessionId: deps.sessionAttachment.sessionId, id: uploadId } } : {}),
    }),
    enableChunkEncryption: true,
  });
}
