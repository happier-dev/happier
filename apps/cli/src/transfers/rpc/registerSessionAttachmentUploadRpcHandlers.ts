import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { TransferSessionStore } from '../core/transferSessionStore';
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

type SessionAttachmentUploadInitRequest = Readonly<{
  messageLocalId: string;
  fileName: string;
  sizeBytes: number;
  uploadLocation?: AttachmentUploadLocation;
  workspaceRelativeDir?: string;
  vcsIgnoreStrategy?: AttachmentVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled?: boolean;
}>;

type SessionAttachmentUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
  | Readonly<{ success: false; error: string }>;

type SessionAttachmentUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string }>;

function resolveAttachmentTransferConfig(request: SessionAttachmentUploadInitRequest | null): AttachmentTransferConfig | null {
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

function sanitizeAttachmentFileName(value: string): string {
  const raw = String(value ?? '');
  const base = raw.split(/[/\\]/g).pop() ?? '';
  const trimmed = base.trim() || 'file';
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? 'file' : collapsed;
  return finalName.length > 200 ? finalName.slice(-200) : finalName;
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

export function registerSessionAttachmentUploadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    store: TransferSessionStore;
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
    sessionRpcTransferMaxBytes?: number | null;
  }>,
): void {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());

  registerUploadTransferLifecycleHandlers<SessionAttachmentUploadInitResponse, SessionAttachmentUploadFinalizeResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as SessionAttachmentUploadInitRequest | null;
      const config = resolveAttachmentTransferConfig(request);
      if (!config) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Invalid workspaceRelativeDir' },
        };
      }

      const resolvedTarget = resolveConfiguredAttachmentTransferTarget({
        config,
        tempUploadRoot,
        workingDirectory: deps.workingDirectory,
      });

      deps.pathAllowanceRegistry.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
      deps.pathAllowanceRegistry.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);

      try {
        await ensureAttachmentIgnoreRule({
          workingDirectory: deps.workingDirectory,
          config,
        });
      } catch {
        // Best effort.
      }

      if (!resolvedTarget.success) {
        return {
          kind: 'rejected',
          response: { success: false, error: resolvedTarget.error },
        };
      }

      if (typeof request?.messageLocalId !== 'string' || request.messageLocalId.trim().length === 0) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Missing messageLocalId' },
        };
      }
      if (typeof request?.fileName !== 'string' || request.fileName.trim().length === 0) {
        return {
          kind: 'rejected',
          response: { success: false, error: 'Missing fileName' },
        };
      }

      const path = buildAttachmentUploadPath({
        uploadBasePath: resolvedTarget.uploadBasePath,
        messageLocalId: request.messageLocalId,
        fileName: request.fileName,
      });

      const target = resolveWorkspaceFileUploadTarget({
        workingDirectory: deps.workingDirectory,
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
    buildFinalizeErrorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Attachment upload finalize failed',
    }),
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
