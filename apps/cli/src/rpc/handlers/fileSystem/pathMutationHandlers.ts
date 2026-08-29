import { realpathSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'fs/promises';
import { basename, dirname, resolve as resolvePath } from 'path';
import { createHash } from 'node:crypto';

import { HARD_OPENABLE_CONTENT_MAX_BYTES_V1, type WorkspaceStatFileRequestV1 } from '@happier-dev/protocol';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { validatePath } from '../pathSecurity';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';

type StatFileRequest = WorkspaceStatFileRequestV1;
type StatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
      /** Metadata status-change time, retained for older metadata consumers. */
      changedMs?: number;
      /** SHA-256 of the current bytes when the file is within the inline read ceiling. */
      contentHash?: string;
    }>
  | Readonly<{ success: false; error: string }>;

type RenamePathRequest = Readonly<{ from: string; to: string; overwrite?: boolean }>;
type RenamePathResponse = Readonly<{ success: true } | { success: false; error: string }>;

type DeletePathRequest = Readonly<{ path: string; recursive?: boolean }>;
type DeletePathResponse = Readonly<{ success: true } | { success: false; error: string }>;

function resolveRealPathBestEffort(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    try {
      const parent = realpathSync(dirname(resolved));
      return resolvePath(parent, basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function isRootPath(resolvedPath: string, workingDirectory: string): boolean {
  const normalizedWorkingDir = resolveRealPathBestEffort(workingDirectory);
  const normalizedTarget = resolveRealPathBestEffort(resolvedPath);
  return normalizedTarget === normalizedWorkingDir;
}

/** Read one exact, bounded candidate buffer for an opt-in content revision. */
async function readFileWithinContentHashLimit(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(HARD_OPENABLE_CONTENT_MAX_BYTES_V1 + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function registerPathMutationHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
    getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
  }>,
): void {
  rpcHandlerManager.registerHandler<StatFileRequest, StatFileResponse>(RPC_METHODS.STAT_FILE, async (data) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    logger.debug('Stat file request:', path);

    const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.error ?? 'Access denied' };
    }

    try {
      const stats = await stat(validation.resolvedPath);
      const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      let contentHash: string | undefined;
      let sizeBytes = stats.size;
      if (data?.includeContentHash === true && kind === 'file' && stats.size <= HARD_OPENABLE_CONTENT_MAX_BYTES_V1) {
        const bytes = await readFileWithinContentHashLimit(validation.resolvedPath);
        // Name the exact buffer hashed, rather than pairing a pre-read stat
        // size with post-read bytes if a concurrent write changed the length.
        // A growth race that crosses the existing inline boundary is not
        // hashed; the next stat can truthfully report it as unsupported.
        if (bytes.byteLength <= HARD_OPENABLE_CONTENT_MAX_BYTES_V1) {
          sizeBytes = bytes.byteLength;
          contentHash = createHash('sha256').update(bytes).digest('hex');
        }
      }
      return {
        success: true,
        exists: true,
        kind,
        sizeBytes,
        modifiedMs: stats.mtimeMs,
        changedMs: stats.ctimeMs,
        ...(contentHash ? { contentHash } : {}),
      };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return { success: true, exists: false };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stat path' };
    }
  });

  rpcHandlerManager.registerHandler<RenamePathRequest, RenamePathResponse>(RPC_METHODS.RENAME_PATH, async (data) => {
    const from = typeof data?.from === 'string' ? data.from : '';
    const to = typeof data?.to === 'string' ? data.to : '';
    const overwrite = Boolean(data?.overwrite);
    logger.debug('Rename path request:', from, '->', to);

    const fromValidation = validatePath(from, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy);
    const toValidation = validatePath(to, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy);
    if (!fromValidation.valid || !fromValidation.resolvedPath) {
      return { success: false, error: fromValidation.error ?? 'Access denied' };
    }
    if (!toValidation.valid || !toValidation.resolvedPath) {
      return { success: false, error: toValidation.error ?? 'Access denied' };
    }

    if (isRootPath(fromValidation.resolvedPath, deps.workingDirectory)) {
      return { success: false, error: 'Cannot rename the working directory root' };
    }
    if (isRootPath(toValidation.resolvedPath, deps.workingDirectory)) {
      return { success: false, error: 'Cannot rename into the working directory root' };
    }

    try {
      const destExists = await stat(toValidation.resolvedPath).then(() => true).catch((e: any) => e?.code !== 'ENOENT');
      if (destExists) {
        if (!overwrite) {
          return { success: false, error: 'Destination already exists' };
        }
        await rm(toValidation.resolvedPath, { recursive: true, force: true });
      }

      await mkdir(dirname(toValidation.resolvedPath), { recursive: true });
      await rename(fromValidation.resolvedPath, toValidation.resolvedPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to rename path' };
    }
  });

  rpcHandlerManager.registerHandler<DeletePathRequest, DeletePathResponse>(RPC_METHODS.DELETE_PATH, async (data) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    const recursive = Boolean(data?.recursive);
    logger.debug('Delete path request:', path, 'recursive:', recursive);

    const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy);
    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.error ?? 'Access denied' };
    }

    if (isRootPath(validation.resolvedPath, deps.workingDirectory)) {
      return { success: false, error: 'Cannot delete the working directory root' };
    }

    try {
      const stats = await stat(validation.resolvedPath);
      if (stats.isDirectory() && !recursive) {
        return { success: false, error: 'Refusing to delete a directory without recursive=true' };
      }

      await rm(validation.resolvedPath, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return { success: true };
      }
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete path' };
    }
  });
}
