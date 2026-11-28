import { randomUUID } from 'crypto';
import { join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
import { resolveSessionMediaTempUploadBasePath } from '../sessionMedia/resolveSessionMediaTransferTarget';
import {
  normalizeSessionMediaPathSegment,
  sanitizeSessionMediaFileName,
} from '../sessionMedia/sanitizeSessionMediaFileName';
import type { TransferPathAllowanceRegistry } from '../targets/createTransferPathAllowanceRegistry';
import { ensureAttachmentIgnoreRule } from '../targets/ensureAttachmentIgnoreRule';
import {
  DEFAULT_ATTACHMENT_TRANSFER_CONFIG,
  normalizeAttachmentUploadLocation,
  normalizeAttachmentVcsIgnoreStrategy,
  normalizeAttachmentWorkspaceRelativeDir,
  resolveConfiguredAttachmentTransferTarget,
  type AttachmentTransferConfig,
  type AttachmentUploadLocation,
  type AttachmentVcsIgnoreStrategy,
} from '../targets/resolveAttachmentTransferTarget';
import { resolveWorkspaceFileUploadTarget } from '../targets/resolveWorkspaceFileUploadTarget';
import { registerUploadTransferLifecycleHandlers } from './registerUploadTransferLifecycleHandlers';

type BulkTransferUploadInitRequest =
  | Readonly<{
      t: 'session_file_upload_v1';
      path: string;
      sizeBytes: number;
      overwrite?: boolean;
      sha256?: string;
    }>
  | Readonly<{
      t: 'session_attachment_upload_v1';
      messageLocalId: string;
      fileName: string;
      sizeBytes: number;
      uploadLocation?: AttachmentUploadLocation;
      workspaceRootPath?: string;
      workspaceRelativeDir?: string;
      vcsIgnoreStrategy?: AttachmentVcsIgnoreStrategy;
      vcsIgnoreWritesEnabled?: boolean;
    }>;

type BulkTransferUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
  | Readonly<{ success: false; error: string }>;

type BulkTransferUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string }>;

function resolveAttachmentTransferConfig(request: Extract<BulkTransferUploadInitRequest, { t: 'session_attachment_upload_v1' }> | null): AttachmentTransferConfig | null {
  const uploadLocation = normalizeAttachmentUploadLocation(request?.uploadLocation) ?? DEFAULT_ATTACHMENT_TRANSFER_CONFIG.uploadLocation;
  const workspaceRelativeDir = request?.workspaceRelativeDir == null
    ? DEFAULT_ATTACHMENT_TRANSFER_CONFIG.workspaceRelativeDir
    : normalizeAttachmentWorkspaceRelativeDir(request.workspaceRelativeDir);
  if (workspaceRelativeDir === null) {
    return null;
  }
  const vcsIgnoreStrategy = normalizeAttachmentVcsIgnoreStrategy(request?.vcsIgnoreStrategy) ?? DEFAULT_ATTACHMENT_TRANSFER_CONFIG.vcsIgnoreStrategy;
  const vcsIgnoreWritesEnabled =
    typeof request?.vcsIgnoreWritesEnabled === 'boolean'
      ? request.vcsIgnoreWritesEnabled
      : DEFAULT_ATTACHMENT_TRANSFER_CONFIG.vcsIgnoreWritesEnabled;

  return {
    uploadLocation,
    workspaceRelativeDir,
    vcsIgnoreStrategy,
    vcsIgnoreWritesEnabled,
  };
}

function resolveAttachmentWorkingDirectory(
  request: Extract<BulkTransferUploadInitRequest, { t: 'session_attachment_upload_v1' }>,
  fallbackWorkingDirectory: string,
): string {
  const workspaceRootPath = typeof request.workspaceRootPath === 'string' ? request.workspaceRootPath.trim() : '';
  return workspaceRootPath.length > 0 ? workspaceRootPath : fallbackWorkingDirectory;
}

function sanitizeAttachmentFileName(value: string): string {
  return sanitizeSessionMediaFileName(value);
}

function normalizeMessageLocalIdSegment(value: unknown): string | null {
  return normalizeSessionMediaPathSegment(value);
}

function joinAttachmentPath(...segments: readonly string[]): string {
  return segments
    .map((segment) => String(segment ?? '').replace(/[\\]+/g, '/'))
    .filter((segment) => segment.length > 0)
    .join('/');
}

function buildAttachmentUploadPath(input: Readonly<{
  uploadBasePath: string;
  messageLocalId: string;
  fileName: string;
}>): string {
  const prefix = randomUUID().slice(0, 8);
  return joinAttachmentPath(
    input.uploadBasePath,
    input.messageLocalId,
    `${prefix}-${sanitizeAttachmentFileName(input.fileName)}`,
  );
}

export function registerBulkTransferUploadRpcHandlers(
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
  const tempUploadRoot = join(resolveSessionMediaTempUploadBasePath(), randomUUID());

  registerUploadTransferLifecycleHandlers<BulkTransferUploadInitResponse, BulkTransferUploadFinalizeResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as BulkTransferUploadInitRequest | null;
      if (!request || typeof request !== 'object') {
        return { kind: 'rejected', response: { success: false, error: 'Invalid request' } };
      }

      if (request.t === 'session_file_upload_v1') {
        const target = resolveWorkspaceFileUploadTarget({
          workingDirectory: deps.workingDirectory,
          accessPolicy: deps.accessPolicy,
          path: request.path,
          sizeBytes: request.sizeBytes,
          overwrite: request.overwrite,
          additionalAllowedWriteDirs: deps.getAdditionalAllowedWriteDirs?.(),
          sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
        });
        if (!target.success) {
          return { kind: 'rejected', response: target };
        }
        const sha256Expected = typeof request.sha256 === 'string' && request.sha256.trim() ? request.sha256.trim() : undefined;
        return {
          kind: 'accepted',
          target: target.target,
          sha256Expected,
          logContext: {
            path: request.path,
          },
        };
      }

      if (request.t !== 'session_attachment_upload_v1') {
        return { kind: 'rejected', response: { success: false, error: 'Unknown upload request type' } };
      }

      if (!deps.attachmentUpload) {
        return { kind: 'rejected', response: { success: false, error: 'Attachment uploads are unavailable' } };
      }

      const config = resolveAttachmentTransferConfig(request);
      if (!config) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Invalid workspaceRelativeDir' },
        };
      }

      const attachmentWorkingDirectory = resolveAttachmentWorkingDirectory(request, deps.workingDirectory);
      const resolvedTarget = resolveConfiguredAttachmentTransferTarget({
        config,
        tempUploadRoot,
        workingDirectory: attachmentWorkingDirectory,
        accessPolicy: deps.accessPolicy,
      });

      if (!resolvedTarget.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: resolvedTarget.error },
        };
      }

      if (typeof request.messageLocalId !== 'string' || request.messageLocalId.trim().length === 0) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Missing messageLocalId' },
        };
      }
      const messageLocalId = normalizeMessageLocalIdSegment(request.messageLocalId);
      if (!messageLocalId) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Invalid messageLocalId' },
        };
      }
      if (typeof request.fileName !== 'string' || request.fileName.trim().length === 0) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Missing fileName' },
        };
      }

      const path = buildAttachmentUploadPath({
        uploadBasePath: resolvedTarget.uploadBasePath,
        messageLocalId,
        fileName: request.fileName,
      });

      const target = resolveWorkspaceFileUploadTarget({
        workingDirectory: attachmentWorkingDirectory,
        accessPolicy: deps.accessPolicy,
        path,
        sizeBytes: request.sizeBytes,
        overwrite: false,
        additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
        sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
      });
      if (!target.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: target.error },
        };
      }

      deps.attachmentUpload.pathAllowanceRegistry.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
      deps.attachmentUpload.pathAllowanceRegistry.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);

      try {
        await ensureAttachmentIgnoreRule({
          workingDirectory: attachmentWorkingDirectory,
          config,
        });
      } catch {
        // Best effort.
      }

      return {
        kind: 'accepted',
        target: target.target,
        logContext: {
          path,
          uploadLocation: config.uploadLocation,
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
