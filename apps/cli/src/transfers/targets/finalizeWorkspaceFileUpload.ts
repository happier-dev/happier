import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';

import type { UploadTransferFinalizeResult } from './uploadTransferTarget';

export async function finalizeWorkspaceFileUpload(input: Readonly<{
  tempPath: string;
  destPath: string;
  destDisplayPath: string;
  overwrite: boolean;
  sizeBytes: number;
}>): Promise<UploadTransferFinalizeResult> {
  await mkdir(dirname(input.destPath), { recursive: true });

  const destStats = await stat(input.destPath).catch((error: unknown) => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  });

  if (destStats) {
    if (destStats.isDirectory()) {
      return { success: false, error: 'Cannot overwrite a directory with a file', keepSession: true };
    }
    if (!input.overwrite) {
      return { success: false, error: 'Destination already exists', keepSession: true };
    }
    await rm(input.destPath, { force: true });
  }

  await rename(input.tempPath, input.destPath);
  return {
    success: true,
    path: input.destDisplayPath,
    sizeBytes: input.sizeBytes,
  };
}
