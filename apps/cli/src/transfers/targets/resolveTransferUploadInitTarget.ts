import type { TransferPathAllowanceRegistry } from './createTransferPathAllowanceRegistry';
import { ensureAttachmentIgnoreRule } from './ensureAttachmentIgnoreRule';
import {
  buildAttachmentUploadPath,
  normalizeAttachmentWorkspaceRootPath,
  resolveConfiguredAttachmentTransferTarget,
  resolveAttachmentTransferConfigFromRequest,
  type AttachmentTransferConfig,
} from './resolveAttachmentTransferTarget';
import {
  resolveWorkspaceFileUploadTarget,
  type WorkspaceFinalizeFileOperationsFactory,
} from './resolveWorkspaceFileUploadTarget';
import {
  resolveComposerMediaStageUploadTarget,
  type ComposerMediaStageUploadInitRequest,
  type ComposerMediaStageUploadTarget,
  type ComposerMediaStageUploadTargetDeps,
} from './resolveComposerMediaStageUploadTarget';
import { normalizeSessionMediaPathId } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';
import { SessionAttachmentUploadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentUploadInitRequestV1';
import type { SessionAttachmentUploadInitRequestV1 } from '@happier-dev/protocol';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { filesystemPathComparisonKey } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferLifecycleDiagnosticContext } from '../rpc/transferLifecycleDiagnostics';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeAttachmentRelativePathV1 } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';

type WorkspaceLikeTransferUploadTarget = Extract<
  ReturnType<typeof resolveWorkspaceFileUploadTarget>,
  { success: true }
>['target'];

type ResolvedTransferUploadTarget = WorkspaceLikeTransferUploadTarget
  | ComposerMediaStageUploadTarget;

export type SessionFileUploadInitRequest = Readonly<{
  t?: 'session_file_upload_v1';
  path: unknown;
  sizeBytes: unknown;
  overwrite?: unknown;
  expectedHash?: unknown;
  sha256?: unknown;
}>;

export type SessionAttachmentUploadInitRequest = SessionAttachmentUploadInitRequestV1;

export type { ComposerMediaStageUploadInitRequest } from './resolveComposerMediaStageUploadTarget';

export type TransferUploadInitRequest =
  | SessionFileUploadInitRequest
  | SessionAttachmentUploadInitRequest
  | ComposerMediaStageUploadInitRequest;

export type TransferUploadInitAttachmentDeps = Readonly<{
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
  resolveSessionWorkingDirectory: (sessionId: string) => Promise<string | null>;
}>;

export type ResolveTransferUploadInitTargetResult =
  | Readonly<{
      success: true;
      target: ResolvedTransferUploadTarget;
      sha256Expected?: string;
      diagnosticContext: TransferLifecycleDiagnosticContext;
    }>
  | Readonly<{
      success: false;
      error: string;
    }>;

export async function resolveTransferUploadInitTarget(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  request: TransferUploadInitRequest;
  tempUploadRoot: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): Promise<ResolveTransferUploadInitTargetResult> {
  if (params.request.t === 'composer_media_stage_upload_v1') {
    if (!params.composerMediaStage) {
      return { success: false, error: 'Composer media staging is unavailable' };
    }
    const target = resolveComposerMediaStageUploadTarget({
      request: params.request,
      deps: params.composerMediaStage,
      sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
    });
    if (!target.success) {
      return target;
    }
    return {
      success: true,
      target: target.target,
      sha256Expected: target.sha256Expected,
      diagnosticContext: {
        transferKind: 'composer_media_stage',
      },
    };
  }

  if (params.request.t === 'session_attachment_upload_v1') {
    const parsed = SessionAttachmentUploadInitRequestV1Schema.safeParse(params.request);
    if (!parsed.success) return { success: false, error: 'Invalid attachment upload request' };
    const request = parsed.data;
    const sessionId = normalizeSessionMediaPathId(request.sessionId);
    if (!sessionId) return { success: false, error: 'Invalid sessionId' };
    const hostedDirectory = await params.attachmentUpload?.resolveSessionWorkingDirectory(sessionId);
    const attachmentWorkingDirectory = normalizeAttachmentWorkspaceRootPath(hostedDirectory);
    if (!attachmentWorkingDirectory) return { success: false, error: 'Attachment Session is not hosted by this daemon' };
    if (request.workspaceRootPath != null) {
      const requestedRoot = normalizeAttachmentWorkspaceRootPath(request.workspaceRootPath);
      if (!requestedRoot || filesystemPathComparisonKey(requestedRoot) !== filesystemPathComparisonKey(attachmentWorkingDirectory)) {
        return { success: false, error: 'Attachment workspace root does not match its Session' };
      }
    }
    const config = resolveAttachmentTransferConfigFromRequest(request) as AttachmentTransferConfig | null;
    if (!config) {
      return { success: false, error: 'Invalid workspaceRelativeDir' };
    }

    const resolvedTarget = resolveConfiguredAttachmentTransferTarget({
      config,
      tempUploadRoot: params.tempUploadRoot,
      workingDirectory: attachmentWorkingDirectory,
      accessPolicy: params.accessPolicy,
    });
    if (!resolvedTarget.success) {
      return { success: false, error: resolvedTarget.error };
    }

    const messageLocalId = normalizeSessionMediaPathId(request.messageLocalId);
    if (!messageLocalId) {
      return { success: false, error: 'Invalid messageLocalId' };
    }
    if (typeof request.fileName !== 'string' || request.fileName.trim().length === 0) {
      return { success: false, error: 'Missing fileName' };
    }

    let path: string;
    try {
      path = buildAttachmentUploadPath({
        uploadBasePath: resolvedTarget.uploadBasePath,
        sessionId,
        messageLocalId,
        fileName: request.fileName,
        ...(request.relativePath === undefined ? {} : { relativePath: request.relativePath }),
      });
    } catch {
      return { success: false, error: 'Invalid attachment relativePath' };
    }

    const target = resolveWorkspaceFileUploadTarget({
      workingDirectory: attachmentWorkingDirectory,
      accessPolicy: params.accessPolicy,
      path,
      sizeBytes: request.sizeBytes,
      overwrite: false,
      additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
      finalizeFileOperations: params.finalizeFileOperations,
    });
    if (!target.success) {
      return { success: false, error: target.error };
    }

    let directoryPaths: string[] | null = null;
    if (request.directoryEntries !== undefined) {
      if (request.sizeBytes !== 0 || !request.relativePath) return { success: false, error: 'Invalid directory upload' };
      directoryPaths = [target.target.destPath];
      for (const entry of request.directoryEntries) {
        const normalized = normalizeAttachmentRelativePathV1(entry);
        if (!normalized) {
          return { success: false, error: 'Invalid attachment directory path' };
        }
        const child = resolveWorkspaceFileUploadTarget({ workingDirectory: attachmentWorkingDirectory,
          accessPolicy: params.accessPolicy, path: join(path, normalized), sizeBytes: 0, overwrite: false,
          additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs });
        if (!child.success) return child;
        directoryPaths.push(child.target.destPath);
      }
    }

    params.attachmentUpload?.pathAllowanceRegistry?.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
    params.attachmentUpload?.pathAllowanceRegistry?.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);

    try {
      await ensureAttachmentIgnoreRule({
        workingDirectory: attachmentWorkingDirectory,
        config,
      });
    } catch {
      // Best effort.
    }

    const directoryTargets = directoryPaths;
    return {
      success: true,
      target: directoryTargets === null ? target.target : { ...target.target,
        finalizeUpload: async ({ tempPath }) => {
          for (const directoryPath of directoryTargets) await mkdir(directoryPath, { recursive: true });
          await unlink(tempPath);
          return { success: true as const, path, sizeBytes: 0 };
        },
      },
      diagnosticContext: {
        transferKind: 'session_attachment',
        destinationClass: config.uploadLocation,
      },
    };
  }

  if (params.request.t !== undefined && params.request.t !== 'session_file_upload_v1') {
    return { success: false, error: 'Unknown upload request type' };
  }
  const fileRequest = params.request;
  const target = resolveWorkspaceFileUploadTarget({
    workingDirectory: params.workingDirectory,
    accessPolicy: params.accessPolicy,
    path: fileRequest.path,
    sizeBytes: fileRequest.sizeBytes,
    overwrite: fileRequest.overwrite,
    expectedHash: fileRequest.expectedHash,
    additionalAllowedWriteDirs: params.additionalAllowedWriteDirs,
    sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
    finalizeFileOperations: params.finalizeFileOperations,
  });
  if (!target.success) {
    return target;
  }
  const sha256Expected = typeof fileRequest.sha256 === 'string' && fileRequest.sha256.trim()
    ? fileRequest.sha256.trim()
    : undefined;
  return {
    success: true,
    target: target.target,
    sha256Expected,
    diagnosticContext: {
      transferKind: 'session_file',
    },
  };
}
