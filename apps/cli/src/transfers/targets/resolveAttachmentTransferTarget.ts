import { randomUUID } from 'crypto';
import { join } from 'path';

import { validatePath } from '@/rpc/handlers/pathSecurity';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import { resolveSessionMediaTransferTarget } from './resolveSessionMediaTransferTarget';
import { resolveWorkspaceFileUploadTarget, type WorkspaceFileUploadTarget } from './resolveWorkspaceFileUploadTarget';

export type AttachmentUploadLocation = 'workspace' | 'os_temp';
export type AttachmentVcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';

export type AttachmentTransferConfig = Readonly<{
  uploadLocation: AttachmentUploadLocation;
  workspaceRelativeDir: string;
  vcsIgnoreStrategy: AttachmentVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled: boolean;
}>;

export type AttachmentTransferTarget = Readonly<{
  uploadBasePath: string;
  additionalAllowedReadDirs: readonly string[];
  additionalAllowedWriteDirs: readonly string[];
}>;

export type ConfiguredAttachmentTransferTargetResult =
  | Readonly<{
      success: true;
      target: AttachmentTransferTarget;
      uploadBasePath: string;
    }>
  | Readonly<{
      success: false;
      target: AttachmentTransferTarget;
      error: string;
    }>;

export const DEFAULT_ATTACHMENT_TRANSFER_CONFIG: AttachmentTransferConfig = {
  uploadLocation: 'workspace',
  workspaceRelativeDir: '.happier/uploads',
  vcsIgnoreStrategy: 'git_info_exclude',
  vcsIgnoreWritesEnabled: true,
};

export function normalizeAttachmentUploadLocation(value: unknown): AttachmentUploadLocation | null {
  if (value === 'workspace' || value === 'os_temp') return value;
  return null;
}

export function normalizeAttachmentVcsIgnoreStrategy(value: unknown): AttachmentVcsIgnoreStrategy | null {
  if (value === 'git_info_exclude' || value === 'gitignore' || value === 'none') return value;
  return null;
}

export function normalizeAttachmentWorkspaceRelativeDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function resolveAttachmentTransferTarget(
  config: AttachmentTransferConfig,
  tempUploadRoot: string,
): AttachmentTransferTarget {
  return resolveSessionMediaTransferTarget({
    config,
    tempUploadRoot,
    category: 'messages',
  });
}

export function sanitizeAttachmentFileName(value: string): string {
  const raw = String(value ?? '');
  const base = raw.split(/[/\\]/g).pop() ?? '';
  const trimmed = base.trim() || 'file';
  const safe = trimmed.replace(/[^\w.\- ()]/g, '_');
  const collapsed = safe.replace(/_+/g, '_');
  const finalName = collapsed === '.' || collapsed === '..' ? 'file' : collapsed;
  return finalName.length > 200 ? finalName.slice(-200) : finalName;
}

export function normalizeMessageLocalIdSegment(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === '.' || trimmed === '..') return null;
  if (trimmed.includes('\0')) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  return trimmed;
}

export function normalizeAttachmentWorkspaceRootPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith('\\\\')) {
    return null;
  }
  return trimmed;
}

export function buildAttachmentUploadPath(input: Readonly<{
  uploadBasePath: string;
  messageLocalId: string;
  fileName: string;
}>): string {
  const prefix = randomUUID().slice(0, 8);
  return join(
    input.uploadBasePath,
    input.messageLocalId,
    `${prefix}-${sanitizeAttachmentFileName(input.fileName)}`,
  ).replace(/[\\]+/g, '/');
}

export function resolveAttachmentTransferConfigFromRequest(request: Readonly<{
  uploadLocation?: unknown;
  workspaceRelativeDir?: unknown;
  vcsIgnoreStrategy?: unknown;
  vcsIgnoreWritesEnabled?: boolean;
}> | null): AttachmentTransferConfig | null {
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

export type AttachmentTransferOpenTargetResult =
  | Readonly<{
      success: true;
      target: WorkspaceFileUploadTarget;
      config: AttachmentTransferConfig;
      workingDirectory: string;
      uploadPath: string;
      messageLocalId: string;
      resolvedTarget: ConfiguredAttachmentTransferTargetResult['target'];
    }>
  | Readonly<{
      success: false;
      error: string;
    }>;

export function resolveAttachmentTransferOpenTarget(input: Readonly<{
  workingDirectory: string;
  tempUploadRoot: string;
  request: Readonly<{
    messageLocalId: unknown;
    fileName: unknown;
    sizeBytes: unknown;
    uploadLocation?: unknown;
    workspaceRootPath?: unknown;
    workspaceRelativeDir?: unknown;
    vcsIgnoreStrategy?: unknown;
    vcsIgnoreWritesEnabled?: boolean;
  }> | null;
  sessionRpcTransferMaxBytes?: number | null;
}>): AttachmentTransferOpenTargetResult {
  const config = resolveAttachmentTransferConfigFromRequest(input.request);
  if (!config) {
    return {
      success: false,
      error: 'Invalid workspaceRelativeDir',
    };
  }

  const attachmentWorkingDirectory = (() => {
    if (config.uploadLocation !== 'workspace') return input.workingDirectory;
    if (input.request?.workspaceRootPath == null) return input.workingDirectory;
    return normalizeAttachmentWorkspaceRootPath(input.request.workspaceRootPath);
  })();
  if (!attachmentWorkingDirectory) {
    return {
      success: false,
      error: 'Invalid workspaceRootPath',
    };
  }

  const resolvedTarget = resolveConfiguredAttachmentTransferTarget({
    config,
    tempUploadRoot: input.tempUploadRoot,
    workingDirectory: attachmentWorkingDirectory,
  });
  if (!resolvedTarget.success) {
    return {
      success: false,
      error: resolvedTarget.error,
    };
  }

  if (typeof input.request?.messageLocalId !== 'string' || input.request.messageLocalId.trim().length === 0) {
    return {
      success: false,
      error: 'Missing messageLocalId',
    };
  }
  const messageLocalId = normalizeMessageLocalIdSegment(input.request.messageLocalId);
  if (!messageLocalId) {
    return {
      success: false,
      error: 'Invalid messageLocalId',
    };
  }
  if (typeof input.request.fileName !== 'string' || input.request.fileName.trim().length === 0) {
    return {
      success: false,
      error: 'Missing fileName',
    };
  }

  const uploadPath = buildAttachmentUploadPath({
    uploadBasePath: resolvedTarget.uploadBasePath,
    messageLocalId,
    fileName: input.request.fileName,
  });

  const target = resolveWorkspaceFileUploadTarget({
    workingDirectory: attachmentWorkingDirectory,
    path: uploadPath,
    sizeBytes: input.request.sizeBytes,
    overwrite: false,
    additionalAllowedWriteDirs: resolvedTarget.target.additionalAllowedWriteDirs,
    sessionRpcTransferMaxBytes: input.sessionRpcTransferMaxBytes ?? null,
  });

  if (!target.success) {
    return {
      success: false,
      error: target.error,
    };
  }

  return {
    success: true,
    target: target.target,
    config,
    workingDirectory: attachmentWorkingDirectory,
    uploadPath,
    messageLocalId,
    resolvedTarget: resolvedTarget.target,
  };
}

export function resolveConfiguredAttachmentTransferTarget(input: Readonly<{
  config: AttachmentTransferConfig;
  tempUploadRoot: string;
  workingDirectory: string;
  accessPolicy?: FilesystemAccessPolicy;
}>): ConfiguredAttachmentTransferTargetResult {
  const target = resolveAttachmentTransferTarget(input.config, input.tempUploadRoot);
  const validation = validatePath(
    target.uploadBasePath,
    input.workingDirectory,
    input.config.uploadLocation === 'workspace' ? undefined : target.additionalAllowedWriteDirs,
    input.accessPolicy,
  );
  if (!validation.valid) {
    return {
      success: false,
      target,
      error: validation.error ?? 'Invalid upload base path',
    };
  }

  return {
    success: true,
    target,
    uploadBasePath: target.uploadBasePath,
  };
}
