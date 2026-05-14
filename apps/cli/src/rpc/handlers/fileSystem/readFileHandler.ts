import { readFile, stat } from 'fs/promises';
import { realpathSync } from 'fs';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

import { validatePath, type PathValidationResult } from '../pathSecurity';
import {
  filesystemPathComparisonKey,
  normalizeFilesystemPathForPolicy,
  type FilesystemAccessPolicy,
} from './accessPolicy/filesystemAccessPolicy';
import { resolveFilesystemTargetPath } from './accessPolicy/filesystemPathAuthorization';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type { ActionId } from '@happier-dev/protocol';

type ReadFileRequest = Readonly<{ path: string }>;

type ReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export type ExactAllowedReadFile =
  | string
  | Readonly<{ path: string; realPath: string }>;

type ReadFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
}>;

function normalizeExactReadFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalizeFilesystemPathForPolicy(path);
  }
}

function validateExactAllowedReadFile(
  path: string,
  deps: ReadFileHandlerDeps,
): PathValidationResult {
  const resolved = resolveFilesystemTargetPath({
    targetPath: path,
    defaultDirectory: deps.workingDirectory,
  });
  if (!resolved.valid) {
    return resolved;
  }

  const targetPathKey = filesystemPathComparisonKey(normalizeFilesystemPathForPolicy(resolved.resolvedPath));
  const targetRealPathKey = filesystemPathComparisonKey(normalizeExactReadFile(resolved.resolvedPath));
  const allowedFiles = deps.getAdditionalAllowedReadFiles?.() ?? [];
  for (const file of allowedFiles) {
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

    const allowedPathKey = filesystemPathComparisonKey(normalizeFilesystemPathForPolicy(file.path.trim()));
    const allowedRealPathKey = filesystemPathComparisonKey(normalizeFilesystemPathForPolicy(file.realPath.trim()));
    if (allowedPathKey === targetPathKey && allowedRealPathKey === targetRealPathKey) {
      return { valid: true, resolvedPath: resolved.resolvedPath };
    }
  }

  return { valid: false, error: `Access denied: Path '${path}' is outside the allowed directories` };
}

async function readFileForRpc(data: ReadFileRequest | undefined, deps: ReadFileHandlerDeps): Promise<ReadFileResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Read file request:', path);

  const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
  const resolvedValidation =
    validation.valid && validation.resolvedPath
      ? validation
      : validateExactAllowedReadFile(path, deps);
  if (!resolvedValidation.valid || !resolvedValidation.resolvedPath) {
    return { success: false, error: resolvedValidation.error ?? validation.error ?? 'Access denied' };
  }

  try {
    const stats = await stat(resolvedValidation.resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: 'Path is a directory' };
    }
    if (stats.size > configuration.filesReadMaxBytes) {
      return { success: false, error: 'File is too large to read' };
    }

    const buffer = await readFile(resolvedValidation.resolvedPath);
    return { success: true, content: buffer.toString('base64') };
  } catch (error) {
    logger.debug('Failed to read file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read file' };
  }
}

function createReadFileRpcActionExecutor(deps: ReadFileHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown) {
      if (actionId !== 'daemon.filesystem.readFile') {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      return {
        ok: true,
        result: await readFileForRpc(input as ReadFileRequest | undefined, deps),
      };
    },
  };
}

export function registerReadFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    actionExecutor?: RpcActionExecutor;
  }>,
): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: deps.actionExecutor ?? createReadFileRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.readFile'],
  });
}
