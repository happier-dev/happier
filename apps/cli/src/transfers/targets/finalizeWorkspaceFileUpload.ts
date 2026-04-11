import { mkdir, stat } from 'fs/promises';
import { dirname } from 'path';

import {
  CrossDeviceMoveSourceCleanupError,
  moveFileWithCrossDeviceFallback,
} from '../../utils/fs/moveFileWithCrossDeviceFallback';
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
  }

  try {
    await moveFileWithCrossDeviceFallback(input.tempPath, input.destPath);
  } catch (error) {
    if (error instanceof CrossDeviceMoveSourceCleanupError && error.destinationRolledBack) {
      return {
        success: false,
        error: 'Failed to finalize uploaded file because the staged upload file is still in use. Retry the upload finalization.',
        keepSession: true,
      };
    }
    throw error;
  }

  return {
    success: true,
    path: input.destDisplayPath,
    sizeBytes: input.sizeBytes,
  };
}
