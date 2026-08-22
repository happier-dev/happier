import { realpathSync } from 'node:fs';

import {
  filesystemPathComparisonKey,
  normalizeFilesystemPathForPolicy,
} from './filesystemAccessPolicy';
import {
  resolveFilesystemTargetPath,
  type FilesystemPathAuthorizationResult,
} from './filesystemPathAuthorization';

export type ExactAllowedReadFile =
  | string
  | Readonly<{ path: string; realPath: string }>;

function normalizeExactReadFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalizeFilesystemPathForPolicy(path);
  }
}

/**
 * Authorizes one transient read grant without turning that grant into a
 * directory allowance. Both legacy READ_FILE and encrypted file transfer use
 * this owner so a preview cannot broaden the same grant differently.
 */
export function authorizeExactAllowedReadFile(input: Readonly<{
  targetPath: unknown;
  workingDirectory: string;
  allowedFiles?: readonly ExactAllowedReadFile[];
}>): FilesystemPathAuthorizationResult {
  const resolved = resolveFilesystemTargetPath({
    targetPath: input.targetPath,
    defaultDirectory: input.workingDirectory,
  });
  if (!resolved.valid) return resolved;

  const targetPathKey = filesystemPathComparisonKey(
    normalizeFilesystemPathForPolicy(resolved.resolvedPath),
  );
  const targetRealPathKey = filesystemPathComparisonKey(
    normalizeExactReadFile(resolved.resolvedPath),
  );
  for (const file of input.allowedFiles ?? []) {
    if (typeof file === 'string') {
      if (file.trim().length === 0) continue;
      const allowedKey = filesystemPathComparisonKey(normalizeExactReadFile(file.trim()));
      if (allowedKey === targetRealPathKey) {
        return { valid: true, resolvedPath: resolved.resolvedPath };
      }
      continue;
    }

    if (
      typeof file?.path !== 'string'
      || file.path.trim().length === 0
      || typeof file.realPath !== 'string'
      || file.realPath.trim().length === 0
    ) {
      continue;
    }

    const allowedPathKey = filesystemPathComparisonKey(
      normalizeFilesystemPathForPolicy(file.path.trim()),
    );
    const allowedRealPathKey = filesystemPathComparisonKey(
      normalizeFilesystemPathForPolicy(file.realPath.trim()),
    );
    if (allowedPathKey === targetPathKey && allowedRealPathKey === targetRealPathKey) {
      return { valid: true, resolvedPath: resolved.resolvedPath };
    }
  }

  return {
    valid: false,
    error: `Access denied: Path '${String(input.targetPath ?? '')}' is outside the allowed directories`,
  };
}
