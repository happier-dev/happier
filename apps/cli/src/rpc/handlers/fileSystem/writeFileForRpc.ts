import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

import { validatePath } from '../pathSecurity';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';

export type WriteFileRequest = Readonly<{ path: string; content: string; expectedHash?: string | null }>;
export type WriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string; errorCode?: 'hash_mismatch' | 'expected_file_missing' | 'expected_file_absent' }>;
export type WriteFileHandlerDeps = Readonly<{
  workingDirectory: string;
  accessPolicy: FilesystemAccessPolicy;
  getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
}>;

/** Best-effort check then write, shared by repository editors and the filesystem RPC. */
export async function writeFileForRpc(data: WriteFileRequest | undefined, deps: WriteFileHandlerDeps): Promise<WriteFileResponse> {
  const path = typeof data?.path === 'string' ? data.path : '';
  logger.debug('Write file request:', path);
  const validation = validatePath(path, deps.workingDirectory, deps.getAdditionalAllowedWriteDirs(), deps.accessPolicy);
  if (!validation.valid || !validation.resolvedPath) return { success: false, error: validation.error ?? 'Access denied' };
  const resolvedPath = validation.resolvedPath;
  try {
    const contentBase64 = typeof data?.content === 'string' ? data.content : '';
    const decodedByteLength = Buffer.byteLength(contentBase64, 'base64');
    const maxInlineWriteBytes = Math.min(configuration.filesReadMaxBytes, configuration.filesTransferChunkBytes);
    if (decodedByteLength > maxInlineWriteBytes) return { success: false, error: 'File content is too large to write' };
    if (data?.expectedHash === undefined) {
      // No expectation: allow best-effort write.
    } else if (data.expectedHash !== null) {
      try {
        const existingStat = await stat(resolvedPath);
        if (existingStat.size > maxInlineWriteBytes) return { success: false, error: 'File is too large to verify hash' };
        const existingBuffer = await readFile(resolvedPath);
        const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
        if (existingHash !== data.expectedHash) return { success: false, errorCode: 'hash_mismatch', error: `File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}` };
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') throw error;
        return { success: false, errorCode: 'expected_file_missing', error: 'File does not exist but hash was provided' };
      }
    } else {
      try {
        await stat(resolvedPath);
        return { success: false, errorCode: 'expected_file_absent', error: 'File already exists but was expected to be new' };
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') throw error;
      }
    }
    await mkdir(dirname(resolvedPath), { recursive: true });
    const buffer = Buffer.from(contentBase64, 'base64');
    await writeFile(resolvedPath, buffer);
    return { success: true, hash: createHash('sha256').update(buffer).digest('hex') };
  } catch (error) {
    logger.debug('Failed to write file:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Failed to write file' };
  }
}
