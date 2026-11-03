import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join, basename } from 'path';

import type { RpcHandlerInvoker, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SessionAttachmentHandleV1 } from '@happier-dev/protocol';
import { sanitizeAttachmentFileName } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';

import { TransferSessionStore } from '@happier-dev/transfers/node';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { createFilesystemEffectRpcRegistrar, type FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import {
  resolveTransferUploadInitTarget,
  type TransferUploadInitRequest,
  type TransferUploadInitAttachmentDeps,
} from '../targets/resolveTransferUploadInitTarget';
import type { ComposerMediaStageUploadTargetDeps } from '../targets/resolveComposerMediaStageUploadTarget';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';
import { createNativeFilesystemTransferRpcRegistrar, type PrepareNativeFilesystemTransfer } from './nativeTransferRpcRegistrar';
import type { WorkspaceFinalizeFileOperationsFactory } from '../targets/resolveWorkspaceFileUploadTarget';
import { sniffSessionMediaMimeTypeFromFile } from '@/session/media/mime';

type TransferUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string; expiresAt?: number }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

type TransferUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string; result?: unknown; attachmentHandle?: SessionAttachmentHandleV1 }>
  | Readonly<{ success: false; error: string; errorCode?: string; expiresAt?: number }>;

export function registerTransferUploadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    effectAdmission?: FilesystemEffectAdmission;
    prepareNativeTransfer?: PrepareNativeFilesystemTransfer;
    finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
    store: TransferSessionStore;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    sessionRpcTransferMaxBytes?: number | null;
    attachmentUpload?: TransferUploadInitAttachmentDeps;
    composerMediaStage?: ComposerMediaStageUploadTargetDeps;
    /** Immutable Session namespace: only attachments are accepted, never caller paths. */
    sessionAttachment?: Readonly<{ sessionId: string }>;
  }>,
): RpcHandlerInvoker {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());

  return registerUploadTransferLifecycleHandlers<TransferUploadInitResponse, TransferUploadFinalizeResponse, unknown>({
    rpcHandlerManager: deps.prepareNativeTransfer ? createNativeFilesystemTransferRpcRegistrar(rpcHandlerManager, {
      direction: 'upload', store: deps.store, prepareNativeTransfer: deps.prepareNativeTransfer,
      fallbackAdmission: deps.effectAdmission?.rpc,
    }) : deps.effectAdmission ? createFilesystemEffectRpcRegistrar(rpcHandlerManager, deps.effectAdmission) : rpcHandlerManager,
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
      if (requestKind === 'session_attachment_upload_v1' && !deps.attachmentUpload) {
        return { kind: 'rejected', response: { success: false, error: 'Attachment uploads are unavailable' } };
      }
      if (requestKind === 'composer_media_stage_upload_v1' && !deps.composerMediaStage) {
        return { kind: 'rejected', response: { success: false, error: 'Composer media staging is unavailable' } };
      }

      const uploadRequest: TransferUploadInitRequest = deps.sessionAttachment && request.t === 'session_attachment_upload_v1'
        ? {
            t: request.t,
            sessionId: deps.sessionAttachment.sessionId,
            messageLocalId: request.messageLocalId,
            fileName: request.fileName,
            ...(request.attachmentId === undefined ? {} : { attachmentId: request.attachmentId }),
            ...(request.relativePath === undefined ? {} : { relativePath: request.relativePath }),
            ...(request.directoryEntries === undefined ? {} : { directoryEntries: request.directoryEntries }),
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
        ...(deps.finalizeFileOperations ? { finalizeFileOperations: deps.finalizeFileOperations } : {}),
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
                const mimeType = uploadRequest.directoryEntries === undefined
                  ? await sniffSessionMediaMimeTypeFromFile(input.tempPath) : null;
                const finalized = await resolved.target.finalizeUpload(input);
                if (finalized.success) {
                  if (uploadRequest.directoryEntries !== undefined) deps.store.issueDirectoryAttachment({
                    uploadId: input.uploadId, sessionId: deps.sessionAttachment!.sessionId,
                    filePath: resolved.target.destPath, name: basename(resolved.target.destPath), displayPath: finalized.path,
                    ...(uploadRequest.attachmentId ? { attachmentId: uploadRequest.attachmentId } : {}),
                  });
                  else deps.store.issueAttachment({
                    uploadId: input.uploadId,
                    sessionId: deps.sessionAttachment!.sessionId,
                    filePath: resolved.target.destPath,
                    name: sanitizeAttachmentFileName(String(uploadRequest.fileName)),
                    displayPath: finalized.path,
                    sizeBytes: finalized.sizeBytes,
                    sha256: input.sha256,
                    ...(mimeType ? { mimeType } : {}),
                    ...(uploadRequest.attachmentId ? { attachmentId: uploadRequest.attachmentId } : {}),
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
