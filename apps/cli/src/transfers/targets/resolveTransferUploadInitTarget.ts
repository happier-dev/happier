import type { TransferPathAllowanceRegistry } from './createTransferPathAllowanceRegistry';
import { ensureAttachmentIgnoreRule } from './ensureAttachmentIgnoreRule';
import {
  buildAttachmentUploadPath,
  normalizeAttachmentWorkspaceRootPath,
  normalizeMessageLocalIdSegment,
  resolveConfiguredAttachmentTransferTarget,
  resolveAttachmentTransferConfigFromRequest,
  type AttachmentTransferConfig,
  type AttachmentUploadLocation,
  type AttachmentVcsIgnoreStrategy,
} from './resolveAttachmentTransferTarget';
import { resolvePromptAssetUploadTarget } from './resolvePromptAssetUploadTarget';
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
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferLifecycleDiagnosticContext } from '../rpc/transferLifecycleDiagnostics';

type WorkspaceLikeTransferUploadTarget = Extract<
  ReturnType<typeof resolveWorkspaceFileUploadTarget>,
  { success: true }
>['target'];

type PromptAssetTransferUploadTarget = Extract<
  ReturnType<typeof resolvePromptAssetUploadTarget>,
  { success: true }
>['target'];

type ResolvedTransferUploadTarget = WorkspaceLikeTransferUploadTarget
  | PromptAssetTransferUploadTarget
  | ComposerMediaStageUploadTarget;

export type SessionFileUploadInitRequest = Readonly<{
  t?: 'session_file_upload_v1';
  path: unknown;
  sizeBytes: unknown;
  overwrite?: unknown;
  sha256?: unknown;
}>;

export type SessionAttachmentUploadInitRequest = Readonly<{
  t: 'session_attachment_upload_v1';
  messageLocalId: unknown;
  fileName: unknown;
  sizeBytes: unknown;
  uploadLocation?: AttachmentUploadLocation;
  workspaceRootPath?: unknown;
  workspaceRelativeDir?: string;
  vcsIgnoreStrategy?: AttachmentVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled?: boolean;
}>;

export type PromptAssetUploadInitRequest = Readonly<{
  t: 'prompt_asset_upload_v1';
  sizeBytes: unknown;
}>;

export type { ComposerMediaStageUploadInitRequest } from './resolveComposerMediaStageUploadTarget';

export type TransferUploadInitRequest =
  | SessionFileUploadInitRequest
  | SessionAttachmentUploadInitRequest
  | PromptAssetUploadInitRequest
  | ComposerMediaStageUploadInitRequest;

export type NonPromptTransferUploadInitRequest =
  | SessionFileUploadInitRequest
  | SessionAttachmentUploadInitRequest
  | ComposerMediaStageUploadInitRequest;

export type TransferUploadInitAttachmentDeps = Readonly<{
  pathAllowanceRegistry?: TransferPathAllowanceRegistry;
}>;

export type TransferUploadInitPromptAssetDeps = Readonly<{
  adapterRegistry: ReadonlyMap<string, PromptAssetAdapter>;
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

type ResolveTransferUploadInitTargetSuccess<TTarget extends ResolvedTransferUploadTarget> = Readonly<{
  success: true;
  target: TTarget;
  sha256Expected?: string;
  diagnosticContext: TransferLifecycleDiagnosticContext;
}>;

type ResolveTransferUploadInitTargetFailure = Readonly<{
  success: false;
  error: string;
}>;

export function resolveTransferUploadInitTarget(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  request: PromptAssetUploadInitRequest;
  tempUploadRoot: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload: TransferUploadInitPromptAssetDeps;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): Promise<ResolveTransferUploadInitTargetSuccess<PromptAssetTransferUploadTarget> | ResolveTransferUploadInitTargetFailure>;

export function resolveTransferUploadInitTarget(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  request: NonPromptTransferUploadInitRequest;
  tempUploadRoot: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload?: TransferUploadInitPromptAssetDeps;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): Promise<ResolveTransferUploadInitTargetSuccess<WorkspaceLikeTransferUploadTarget | ComposerMediaStageUploadTarget> | ResolveTransferUploadInitTargetFailure>;

export function resolveTransferUploadInitTarget(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  request: TransferUploadInitRequest;
  tempUploadRoot: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload?: TransferUploadInitPromptAssetDeps;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): Promise<ResolveTransferUploadInitTargetResult>;

export async function resolveTransferUploadInitTarget(params: Readonly<{
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
  request: TransferUploadInitRequest;
  tempUploadRoot: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload?: TransferUploadInitPromptAssetDeps;
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

  if (params.request.t === 'prompt_asset_upload_v1') {
    if (!params.promptAssetUpload) {
      return { success: false, error: 'Prompt asset uploads are unavailable' };
    }
    const target = resolvePromptAssetUploadTarget({
      adapterRegistry: params.promptAssetUpload.adapterRegistry,
      sizeBytes: params.request.sizeBytes,
    });
    if (!target.success) {
      return { success: false, error: target.error };
    }
    return {
      success: true,
      target: target.target,
      diagnosticContext: {
        transferKind: 'prompt_asset',
      },
    };
  }

  if (params.request.t === 'session_attachment_upload_v1') {
    const config = resolveAttachmentTransferConfigFromRequest(params.request) as AttachmentTransferConfig | null;
    if (!config) {
      return { success: false, error: 'Invalid workspaceRelativeDir' };
    }

    const attachmentWorkingDirectory = (() => {
      if (config.uploadLocation !== 'workspace') return params.workingDirectory;
      if (params.request.workspaceRootPath == null) return params.workingDirectory;
      return normalizeAttachmentWorkspaceRootPath(params.request.workspaceRootPath);
    })();
    if (!attachmentWorkingDirectory) {
      return { success: false, error: 'Invalid workspaceRootPath' };
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

    const messageLocalId = normalizeMessageLocalIdSegment(params.request.messageLocalId);
    if (!messageLocalId) {
      return { success: false, error: 'Invalid messageLocalId' };
    }
    if (typeof params.request.fileName !== 'string' || params.request.fileName.trim().length === 0) {
      return { success: false, error: 'Missing fileName' };
    }

    const path = buildAttachmentUploadPath({
      uploadBasePath: resolvedTarget.uploadBasePath,
      messageLocalId,
      fileName: params.request.fileName,
    });

    const target = resolveWorkspaceFileUploadTarget({
      workingDirectory: attachmentWorkingDirectory,
      accessPolicy: params.accessPolicy,
      path,
      sizeBytes: params.request.sizeBytes,
      overwrite: false,
      additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes: params.sessionRpcTransferMaxBytes ?? null,
      finalizeFileOperations: params.finalizeFileOperations,
    });
    if (!target.success) {
      return { success: false, error: target.error };
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

    return {
      success: true,
      target: target.target,
      diagnosticContext: {
        transferKind: 'session_attachment',
        destinationClass: config.uploadLocation,
      },
    };
  }

  const fileRequest = params.request as SessionFileUploadInitRequest;
  const target = resolveWorkspaceFileUploadTarget({
    workingDirectory: params.workingDirectory,
    accessPolicy: params.accessPolicy,
    path: fileRequest.path,
    sizeBytes: fileRequest.sizeBytes,
    overwrite: fileRequest.overwrite,
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
