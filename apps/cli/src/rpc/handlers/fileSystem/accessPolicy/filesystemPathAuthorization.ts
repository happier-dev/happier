import { realpathSync } from 'node:fs';
import { basename, dirname, posix, win32 } from 'node:path';

import {
  filesystemPathComparisonKey,
  type FilesystemAccessPolicy,
  isFilesystemPathAbsolute,
  normalizeFilesystemPathForPolicy,
} from './filesystemAccessPolicy';

export type FilesystemPathAuthorizationResult =
  | Readonly<{ valid: true; resolvedPath: string }>
  | Readonly<{ valid: false; error: string }>;

type AuthorizeFilesystemPathInput = Readonly<{
  targetPath: unknown;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  additionalAllowedDirs?: readonly string[];
  platform?: NodeJS.Platform;
}>;

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function resolveRealPathForAuthorization(pathValue: string, platform: NodeJS.Platform): string {
  const resolved = normalizeFilesystemPathForPolicy(pathValue, platform);
  if (platform !== process.platform) {
    return resolved;
  }

  try {
    return realpathSync(resolved);
  } catch {
    try {
      const parent = realpathSync(dirname(resolved));
      return normalizeFilesystemPathForPolicy(pathApi(platform).join(parent, basename(resolved)), platform);
    } catch {
      return resolved;
    }
  }
}

function resolveAllowedRootForAuthorization(pathValue: string, platform: NodeJS.Platform): string {
  const resolved = normalizeFilesystemPathForPolicy(pathValue, platform);
  if (platform !== process.platform) {
    return resolved;
  }

  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isWithinRoot(targetPath: string, rootPath: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const target = filesystemPathComparisonKey(resolveRealPathForAuthorization(targetPath, platform), platform);
  const root = filesystemPathComparisonKey(resolveAllowedRootForAuthorization(rootPath, platform), platform);
  const relativePath = api.relative(root, target);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${api.sep}`) && !api.isAbsolute(relativePath));
}

function normalizeAdditionalAllowedDirs(
  additionalAllowedDirs: readonly string[] | undefined,
  platform: NodeJS.Platform,
): string[] {
  return (additionalAllowedDirs ?? [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim())
    .filter((value) => isFilesystemPathAbsolute(value, platform))
    .map((value) => normalizeFilesystemPathForPolicy(value, platform));
}

export function resolveFilesystemTargetPath(input: Readonly<{
  targetPath: unknown;
  defaultDirectory: string;
  platform?: NodeJS.Platform;
}>): FilesystemPathAuthorizationResult {
  const platform = input.platform ?? process.platform;
  const api = pathApi(platform);
  const targetPath = typeof input.targetPath === 'string' ? input.targetPath : '';
  if (targetPath.length === 0) {
    return { valid: false, error: 'Path is required' };
  }
  if (targetPath.includes('\0')) {
    return { valid: false, error: 'Access denied: Path contains invalid characters' };
  }
  if (!input.defaultDirectory || typeof input.defaultDirectory !== 'string') {
    return { valid: false, error: 'Access denied: Invalid working directory' };
  }

  const defaultDirectory = input.defaultDirectory.trim();
  if (!isFilesystemPathAbsolute(defaultDirectory, platform)) {
    return { valid: false, error: 'Access denied: Invalid working directory' };
  }

  const resolvedPath = isFilesystemPathAbsolute(targetPath, platform)
    ? normalizeFilesystemPathForPolicy(targetPath, platform)
    : normalizeFilesystemPathForPolicy(api.resolve(defaultDirectory, targetPath), platform);

  return { valid: true, resolvedPath };
}

export function authorizeFilesystemPath(input: AuthorizeFilesystemPathInput): FilesystemPathAuthorizationResult {
  const platform = input.platform ?? process.platform;
  const resolved = resolveFilesystemTargetPath({
    targetPath: input.targetPath,
    defaultDirectory: input.defaultDirectory,
    platform,
  });
  if (!resolved.valid) {
    return resolved;
  }

  if (input.accessPolicy.kind === 'osUser') {
    return resolved;
  }

  const allowedRoots = [
    ...input.accessPolicy.roots,
    ...normalizeAdditionalAllowedDirs(input.additionalAllowedDirs, platform),
  ];
  for (const root of allowedRoots) {
    if (isWithinRoot(resolved.resolvedPath, root, platform)) {
      return resolved;
    }
  }

  return {
    valid: false,
    error: `Access denied: Path '${String(input.targetPath ?? '')}' is outside the allowed directories`,
  };
}
