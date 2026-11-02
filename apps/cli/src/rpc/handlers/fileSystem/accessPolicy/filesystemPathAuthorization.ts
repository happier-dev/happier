import { readlinkSync, realpathSync } from 'node:fs';
import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, posix, win32 } from 'node:path';

import {
  filesystemPathComparisonKey,
  type FilesystemAccessPolicy,
  isFilesystemPathAbsolute,
  normalizeFilesystemPathForPolicy,
} from './filesystemAccessPolicy';

export type FilesystemPathAuthorizationResult =
  | Readonly<{ valid: true; resolvedPath: string; error?: never }>
  | Readonly<{ valid: false; error: string; errorCode: 'access_denied'; resolvedPath?: never }>;

export type AuthorizeFilesystemPathInput = Readonly<{
  targetPath: unknown;
  defaultDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  additionalAllowedDirs?: readonly string[];
  platform?: NodeJS.Platform;
}>;

export type FilesystemPathAuthorizer = (
  targetPath: unknown,
) => Promise<FilesystemPathAuthorizationResult>;

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

function pathErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function isMissingPath(error: unknown): boolean {
  return pathErrorCode(error) === 'ENOENT' || pathErrorCode(error) === 'ENOTDIR';
}

function resolveRealPathForAuthorization(pathValue: string, platform: NodeJS.Platform, pathRepresentation?: 'native_literal'): string {
  const resolved = pathRepresentation === 'native_literal' ? pathValue : normalizeFilesystemPathForPolicy(pathValue, platform);
  if (platform !== process.platform) {
    return resolved;
  }

  const api = pathApi(platform);
  const missingSegments: string[] = [];
  let candidate = resolved;
  while (true) {
    try {
      const realAncestor = pathRepresentation === 'native_literal' ? realpathSync.native(candidate) : realpathSync(candidate);
      return normalizeFilesystemPathForPolicy(
        api.join(realAncestor, ...missingSegments.reverse()),
        platform,
      );
    } catch (error) {
      if (!isMissingPath(error) && !(pathRepresentation === 'native_literal' && pathErrorCode(error) === 'ELOOP')) throw error;
      // realpath cannot open a dangling link. Resolve its destination before
      // appending the missing suffix, so a write cannot escape through it.
      if (pathRepresentation !== 'native_literal') {
        try {
          const destination = readlinkSync(candidate);
          return resolveRealPathForAuthorization(api.resolve(api.dirname(candidate), destination, ...missingSegments.reverse()), platform);
        } catch (linkError) {
          if (!isMissingPath(linkError) && pathErrorCode(linkError) !== 'EINVAL') throw linkError;
        }
      }
      const parent = dirname(candidate);
      if (parent === candidate) return resolved;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

/** Resolve native spelling before any lexical dot-segment normalization.
 * Missing/cyclic suffixes have no readable target; their nearest real ancestor
 * still proves whether the literal path can escape the owning root.
 */
export function resolveNativeFilesystemPathForAuthorization(pathValue: string): string {
  if (!pathApi(process.platform).isAbsolute(pathValue)) throw new Error('A native filesystem path must be absolute');
  return resolveRealPathForAuthorization(pathValue, process.platform, 'native_literal');
}

function resolveAllowedRootForAuthorization(pathValue: string, platform: NodeJS.Platform): string {
  return resolveRealPathForAuthorization(pathValue, platform);
}

async function resolveRealPathForAuthorizationAsync(pathValue: string, platform: NodeJS.Platform): Promise<string> {
  const resolved = normalizeFilesystemPathForPolicy(pathValue, platform);
  if (platform !== process.platform) {
    return resolved;
  }

  const api = pathApi(platform);
  const missingSegments: string[] = [];
  let candidate = resolved;
  while (true) {
    try {
      const realAncestor = await realpath(candidate);
      return normalizeFilesystemPathForPolicy(
        api.join(realAncestor, ...missingSegments.reverse()),
        platform,
      );
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      try {
        const destination = await readlink(candidate);
        return await resolveRealPathForAuthorizationAsync(api.resolve(api.dirname(candidate), destination, ...missingSegments.reverse()), platform);
      } catch (linkError) {
        if (!isMissingPath(linkError) && pathErrorCode(linkError) !== 'EINVAL') throw linkError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return resolved;
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isWithinResolvedRoot(targetPath: string, rootPath: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform);
  const relativePath = api.relative(rootPath, targetPath);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${api.sep}`) && !api.isAbsolute(relativePath));
}

function isWithinRoot(targetPath: string, rootPath: string, platform: NodeJS.Platform): boolean {
  const target = filesystemPathComparisonKey(resolveRealPathForAuthorization(targetPath, platform), platform);
  const root = filesystemPathComparisonKey(resolveAllowedRootForAuthorization(rootPath, platform), platform);
  return isWithinResolvedRoot(target, root, platform);
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
    return { valid: false, error: 'Path is required', errorCode: 'access_denied' };
  }
  if (targetPath.includes('\0')) {
    return { valid: false, error: 'Access denied: Path contains invalid characters', errorCode: 'access_denied' };
  }
  if (!input.defaultDirectory || typeof input.defaultDirectory !== 'string') {
    return { valid: false, error: 'Access denied: Invalid working directory', errorCode: 'access_denied' };
  }

  const defaultDirectory = input.defaultDirectory.trim();
  if (!isFilesystemPathAbsolute(defaultDirectory, platform)) {
    return { valid: false, error: 'Access denied: Invalid working directory', errorCode: 'access_denied' };
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
  try {
    for (const root of allowedRoots) {
      if (isWithinRoot(resolved.resolvedPath, root, platform)) {
        return resolved;
      }
    }
  } catch {
    return { valid: false, error: 'Access denied: Path could not be resolved', errorCode: 'access_denied' };
  }

  return {
    valid: false,
    errorCode: 'access_denied',
    error: `Access denied: Path '${String(input.targetPath ?? '')}' is outside the allowed directories`,
  };
}

/** Admit the checkout under host policy, then confine its entry under that exact root. */
export function authorizeFilesystemPathWithinRoot(
  input: AuthorizeFilesystemPathInput & Readonly<{ rootPath: string }>,
): (Readonly<{ valid: true; resolvedPath: string; rootPath: string; error?: never }> | Extract<FilesystemPathAuthorizationResult, { valid: false }>) {
  if (!isFilesystemPathAbsolute(input.rootPath, input.platform)) {
    return { valid: false, error: 'The filesystem root must be absolute', errorCode: 'access_denied' };
  }
  const root = authorizeFilesystemPath({ ...input, targetPath: input.rootPath });
  if (!root.valid) return root;
  const confined = authorizeFilesystemPath({
    targetPath: input.targetPath, defaultDirectory: root.resolvedPath,
    accessPolicy: { kind: 'restrictedRoots', roots: [root.resolvedPath] },
    platform: input.platform,
  });
  if (!confined.valid) return confined;
  const admitted = authorizeFilesystemPath({ ...input, targetPath: confined.resolvedPath, defaultDirectory: root.resolvedPath });
  return admitted.valid ? { ...admitted, rootPath: root.resolvedPath } : admitted;
}

export async function prepareFilesystemPathAuthorizer(
  input: Omit<AuthorizeFilesystemPathInput, 'targetPath'>,
): Promise<FilesystemPathAuthorizer> {
  const platform = input.platform ?? process.platform;
  if (input.accessPolicy.kind === 'osUser') {
    return async (targetPath) => resolveFilesystemTargetPath({
      targetPath,
      defaultDirectory: input.defaultDirectory,
      platform,
    });
  }

  const allowedRoots = [
    ...input.accessPolicy.roots,
    ...normalizeAdditionalAllowedDirs(input.additionalAllowedDirs, platform),
  ];
  const resolvedRootKeys = await Promise.all(allowedRoots.map(async (root) => (
    filesystemPathComparisonKey(await resolveRealPathForAuthorizationAsync(root, platform), platform)
  )));

  return async (targetPath) => {
    const resolved = resolveFilesystemTargetPath({
      targetPath,
      defaultDirectory: input.defaultDirectory,
      platform,
    });
    if (!resolved.valid) return resolved;

    let resolvedTargetKey: string;
    try {
      resolvedTargetKey = filesystemPathComparisonKey(await resolveRealPathForAuthorizationAsync(resolved.resolvedPath, platform), platform);
    } catch {
      return { valid: false, error: 'Access denied: Path could not be resolved', errorCode: 'access_denied' };
    }
    for (const root of resolvedRootKeys) {
      if (isWithinResolvedRoot(resolvedTargetKey, root, platform)) {
        return resolved;
      }
    }

    return {
      valid: false,
      errorCode: 'access_denied',
      error: `Access denied: Path '${String(targetPath ?? '')}' is outside the allowed directories`,
    };
  };
}
