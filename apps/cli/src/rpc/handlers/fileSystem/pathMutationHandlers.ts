import { realpathSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { basename, dirname, resolve as resolvePath } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { validatePath } from '../pathSecurity';

type StatFileRequest = Readonly<{ path: string }>;
type StatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
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

export function registerPathMutationHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{ workingDirectory: string }>,
): void {
  rpcHandlerManager.registerHandler<StatFileRequest, StatFileResponse>(RPC_METHODS.STAT_FILE, async (data) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    logger.debug('Stat file request:', path);

    const validation = validatePath(path, deps.workingDirectory);
    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.error ?? 'Access denied' };
    }

    try {
      const stats = await stat(validation.resolvedPath);
      const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      return {
        success: true,
        exists: true,
        kind,
        sizeBytes: stats.size,
        modifiedMs: stats.mtime.getTime(),
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

    const fromValidation = validatePath(from, deps.workingDirectory);
    const toValidation = validatePath(to, deps.workingDirectory);
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

    const validation = validatePath(path, deps.workingDirectory);
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
