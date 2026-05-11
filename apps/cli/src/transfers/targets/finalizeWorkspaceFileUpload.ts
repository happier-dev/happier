import { constants } from 'fs';
import { copyFile, mkdir, rm, stat } from 'fs/promises';
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

  if (!input.overwrite) {
    try {
      await copyFile(input.tempPath, input.destPath, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code === 'EEXIST') {
        return { success: false, error: 'Destination already exists', keepSession: true };
      }
      throw error;
    }
    try {
      await rm(input.tempPath, { force: true });
    } catch (error) {
      await rm(input.destPath, { force: true }).catch(() => undefined);
      throw new CrossDeviceMoveSourceCleanupError({
        sourcePath: input.tempPath,
        destPath: input.destPath,
        destinationRolledBack: true,
        cause: error,
      });
    }
    return {
      success: true,
      path: input.destDisplayPath,
      sizeBytes: input.sizeBytes,
    };
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
