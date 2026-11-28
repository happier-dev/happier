import { randomUUID } from 'crypto';
import { normalizeAttachmentRelativePathV1, sanitizeAttachmentFileName } from '@happier-dev/protocol/transfers/attachments/attachmentPathV1';

import { buildSessionMediaFilePath, buildSessionMediaStoredFileName } from '@happier-dev/protocol/sessions/messages/sessionMediaV1';

import { validatePath } from '@/rpc/handlers/pathSecurity';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import { DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG, resolveSessionMediaTransferTarget } from './resolveSessionMediaTransferTarget';

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

export const DEFAULT_ATTACHMENT_TRANSFER_CONFIG: AttachmentTransferConfig = DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG;

export function normalizeAttachmentUploadLocation(value: unknown): AttachmentUploadLocation | null {
  if (value === 'workspace' || value === 'os_temp') return value;
  return null;
}

export function normalizeAttachmentVcsIgnoreStrategy(value: unknown): AttachmentVcsIgnoreStrategy | null {
  if (value === 'git_info_exclude' || value === 'gitignore' || value === 'none') return value;
  return null;
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
  sessionId: string;
  messageLocalId: string;
  fileName: string;
  relativePath?: string;
}>): string {
  const relativeFilePath = input.relativePath === undefined
    ? buildSessionMediaStoredFileName(randomUUID().slice(0, 8), sanitizeAttachmentFileName(input.fileName))
    : normalizeAttachmentRelativePathV1(input.relativePath);
  if (!relativeFilePath) throw new Error('Invalid attachment relativePath');
  return buildSessionMediaFilePath({
    categoryDirectory: input.uploadBasePath,
    sessionId: input.sessionId,
    messageLocalId: input.messageLocalId,
    relativeFilePath,
  });
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
    : normalizeAttachmentRelativePathV1(request.workspaceRelativeDir);
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
