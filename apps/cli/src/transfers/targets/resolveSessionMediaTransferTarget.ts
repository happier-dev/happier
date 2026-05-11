import { join } from 'node:path';

import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

export type SessionMediaUploadLocation = 'workspace' | 'os_temp';
export type SessionMediaVcsIgnoreStrategy = 'git_info_exclude' | 'gitignore' | 'none';
export type SessionMediaTransferCategory = 'messages' | 'generated' | 'artifacts';
export type PersistedSessionMediaCategory = 'attachment' | 'generated' | 'tool-artifact';

export type SessionMediaTransferConfig = Readonly<{
  uploadLocation: SessionMediaUploadLocation;
  workspaceRelativeDir: string;
  vcsIgnoreStrategy: SessionMediaVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled: boolean;
}>;

export type SessionMediaTransferTarget = Readonly<{
  uploadBasePath: string;
  additionalAllowedReadDirs: readonly string[];
  additionalAllowedWriteDirs: readonly string[];
}>;

export type ConfiguredSessionMediaTransferTargetResult =
  | Readonly<{
      success: true;
      target: SessionMediaTransferTarget;
      uploadBasePath: string;
    }>
  | Readonly<{
      success: false;
      target: SessionMediaTransferTarget;
      error: string;
    }>;

export const DEFAULT_SESSION_MEDIA_TRANSFER_CONFIG: SessionMediaTransferConfig = {
  uploadLocation: 'workspace',
  workspaceRelativeDir: '.happier/uploads',
  vcsIgnoreStrategy: 'git_info_exclude',
  vcsIgnoreWritesEnabled: true,
};

export function normalizeSessionMediaWorkspaceRelativeDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  if (/^[a-zA-Z]:/.test(trimmed)) return null;
  const parts = trimmed.split(/[\\/]+/g).filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

export function persistedSessionMediaCategoryToTransferCategory(
  category: PersistedSessionMediaCategory,
): SessionMediaTransferCategory {
  if (category === 'attachment') return 'messages';
  if (category === 'tool-artifact') return 'artifacts';
  return 'generated';
}

function isDurableSessionMediaCategory(category: SessionMediaTransferCategory): boolean {
  return category === 'generated' || category === 'artifacts';
}

export function resolveSessionMediaTransferTarget(input: Readonly<{
  config: SessionMediaTransferConfig;
  tempUploadRoot: string;
  category: SessionMediaTransferCategory;
}>): SessionMediaTransferTarget {
  const workspaceRelativeDir =
    normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir)
    ?? input.config.workspaceRelativeDir.trim();

  if (input.config.uploadLocation === 'workspace') {
    return {
      uploadBasePath: join(workspaceRelativeDir, input.category).replace(/[\\]+/g, '/'),
      additionalAllowedReadDirs: [],
      additionalAllowedWriteDirs: [],
    };
  }

  return {
    uploadBasePath: join(input.tempUploadRoot, input.category),
    additionalAllowedReadDirs: [input.tempUploadRoot],
    additionalAllowedWriteDirs: [input.tempUploadRoot],
  };
}

export function resolveConfiguredSessionMediaTransferTarget(input: Readonly<{
  config: SessionMediaTransferConfig;
  tempUploadRoot: string;
  workingDirectory: string;
  category: SessionMediaTransferCategory;
  accessPolicy?: FilesystemAccessPolicy;
}>): ConfiguredSessionMediaTransferTargetResult {
  const workspaceRelativeDir = normalizeSessionMediaWorkspaceRelativeDir(input.config.workspaceRelativeDir);
  const effectiveConfig = workspaceRelativeDir
    ? { ...input.config, workspaceRelativeDir }
    : input.config;
  const target = resolveSessionMediaTransferTarget({
    config: effectiveConfig,
    tempUploadRoot: input.tempUploadRoot,
    category: input.category,
  });

  if (!workspaceRelativeDir) {
    return { success: false, target, error: 'Invalid workspaceRelativeDir' };
  }
  if (isDurableSessionMediaCategory(input.category) && effectiveConfig.uploadLocation !== 'workspace') {
    return {
      success: false,
      target,
      error: `Session media category ${input.category} must use workspace storage`,
    };
  }

  const authorization = authorizeFilesystemPath({
    targetPath: target.uploadBasePath,
    defaultDirectory: input.workingDirectory,
    accessPolicy: input.accessPolicy ?? { kind: 'osUser' },
    additionalAllowedDirs: target.additionalAllowedWriteDirs,
  });
  if (!authorization.valid) {
    return {
      success: false,
      target,
      error: authorization.error,
    };
  }

  return {
    success: true,
    target,
    uploadBasePath: target.uploadBasePath,
  };
}
