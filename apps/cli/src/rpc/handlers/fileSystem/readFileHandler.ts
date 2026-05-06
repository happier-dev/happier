import { readFile, stat } from 'fs/promises';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';

import { validatePath } from '../pathSecurity';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import type { ActionId } from '@happier-dev/protocol';

type ReadFileRequest = Readonly<{ path: string }>;

type ReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

type ReadFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
}>;

async function readFileForRpc(data: ReadFileRequest | undefined, deps: ReadFileHandlerDeps): Promise<ReadFileResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Read file request:', path);

  const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs(), deps.accessPolicy);
  if (!validation.valid || !validation.resolvedPath) {
    return { success: false, error: validation.error ?? 'Access denied' };
  }

  try {
    const stats = await stat(validation.resolvedPath);
    if (stats.isDirectory()) {
      return { success: false, error: 'Path is a directory' };
    }
    if (stats.size > configuration.filesReadMaxBytes) {
      return { success: false, error: 'File is too large to read' };
    }

    const buffer = await readFile(validation.resolvedPath);
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
    actionExecutor?: RpcActionExecutor;
  }>,
): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: deps.actionExecutor ?? createReadFileRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.readFile'],
  });
}
