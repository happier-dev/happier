import { createHash } from 'crypto';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';

import { configuration } from '@/configuration';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { logger } from '@/ui/logger';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { validatePath } from '../pathSecurity';

type WriteFileRequest = Readonly<{
  path: string;
  content: string;
  expectedHash?: string | null;
}>;

type WriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string }>;

export function registerWriteFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{ workingDirectory: string }>,
): void {
  rpcHandlerManager.registerHandler<WriteFileRequest, WriteFileResponse>(RPC_METHODS.WRITE_FILE, async (data) => {
    const path = typeof data?.path === 'string' ? data.path : '';
    logger.debug('Write file request:', path);

    const validation = validatePath(path, deps.workingDirectory);
    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.error ?? 'Access denied' };
    }

    const resolvedPath = validation.resolvedPath;
    try {
      const contentBase64 = typeof data?.content === 'string' ? data.content : '';
      const decodedByteLength = Buffer.byteLength(contentBase64, 'base64');
      const maxInlineWriteBytes = Math.min(configuration.filesReadMaxBytes, configuration.filesTransferChunkBytes);
      if (decodedByteLength > maxInlineWriteBytes) {
        return { success: false, error: 'File content is too large to write' };
      }

      if (data.expectedHash === undefined) {
        // No expectation: allow best-effort write.
      } else if (data.expectedHash !== null) {
        try {
          const existingStat = await stat(resolvedPath);
          if (existingStat.size > maxInlineWriteBytes) {
            return { success: false, error: 'File is too large to verify hash' };
          }

          const existingBuffer = await readFile(resolvedPath);
          const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
          if (existingHash !== data.expectedHash) {
            return {
              success: false,
              error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`,
            };
          }
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') throw error;
          return { success: false, error: 'File does not exist but hash was provided' };
        }
      } else {
        try {
          await stat(resolvedPath);
          return { success: false, error: 'File already exists but was expected to be new' };
        } catch (error) {
          const nodeError = error as NodeJS.ErrnoException;
          if (nodeError.code !== 'ENOENT') throw error;
        }
      }

      await mkdir(dirname(resolvedPath), { recursive: true });
      const buffer = Buffer.from(contentBase64, 'base64');
      await writeFile(resolvedPath, buffer);

      const hash = createHash('sha256').update(buffer).digest('hex');
      return { success: true, hash };
    } catch (error) {
      logger.debug('Failed to write file:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
    }
  });
}
