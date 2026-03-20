import { readFile, stat } from 'fs/promises';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { validatePath } from '../pathSecurity';

type ReadFileRequest = Readonly<{ path: string }>;

type ReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export function registerReadFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    getAdditionalAllowedReadDirs: () => ReadonlyArray<string>;
  }>,
): void {
  rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.READ_FILE, async (data) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    logger.debug('Read file request:', path);

    const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedReadDirs());
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
  });
}

