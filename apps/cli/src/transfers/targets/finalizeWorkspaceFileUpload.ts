import { constants } from 'fs';
import { copyFile, mkdir, rm, stat } from 'fs/promises';
import { dirname } from 'path';

import {
  CrossDeviceMoveSourceCleanupError,
  moveFileWithCrossDeviceFallback,
  type MoveFileOperations,
} from '../../utils/fs/moveFileWithCrossDeviceFallback';
import {
  TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
  type UploadTransferFinalizeResult,
} from './uploadTransferTarget';

export type WorkspaceFileFinalizeOperations = MoveFileOperations;

function mapCrossDeviceRecoveryFailure(
  error: CrossDeviceMoveSourceCleanupError,
): UploadTransferFinalizeResult {
  if (!error.destinationRolledBack) {
    return {
      success: false,
      error: 'Failed to finalize uploaded file because destination recovery was incomplete. Recovery files were preserved; inspect the destination before retrying.',
      errorCode: TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
      keepSession: true,
    };
  }

  return {
    success: false,
    error: 'Failed to finalize uploaded file because the staged upload file is still in use. Retry the upload finalization.',
    keepSession: true,
  };
}

export async function finalizeWorkspaceFileUpload(input: Readonly<{
  tempPath: string;
  destPath: string;
  destDisplayPath: string;
  overwrite: boolean;
  sizeBytes: number;
  fileOperations?: WorkspaceFileFinalizeOperations | null;
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
    const copyFileOperation = input.fileOperations?.copyFile ?? copyFile;
    const rmOperation = input.fileOperations?.rm ?? rm;
    try {
      await copyFileOperation(input.tempPath, input.destPath, constants.COPYFILE_EXCL);
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
      if (code === 'EEXIST') {
        return { success: false, error: 'Destination already exists', keepSession: true };
      }
      throw error;
    }
    try {
      await rmOperation(input.tempPath, { force: true });
    } catch (error) {
      try {
        await rmOperation(input.destPath, { force: true });
      } catch (rollbackError) {
        return mapCrossDeviceRecoveryFailure(new CrossDeviceMoveSourceCleanupError({
          sourcePath: input.tempPath,
          destPath: input.destPath,
          backupPath: null,
          destinationRolledBack: false,
          cause: new AggregateError(
            [error, rollbackError],
            'Failed to clean up the staged upload source and roll back the copied destination',
          ),
        }));
      }
      return mapCrossDeviceRecoveryFailure(new CrossDeviceMoveSourceCleanupError({
        sourcePath: input.tempPath,
        destPath: input.destPath,
        backupPath: null,
        destinationRolledBack: true,
        cause: error,
      }));
    }
    return {
      success: true,
      path: input.destDisplayPath,
      sizeBytes: input.sizeBytes,
    };
  }

  try {
    await moveFileWithCrossDeviceFallback(
      input.tempPath,
      input.destPath,
      input.fileOperations ?? undefined,
    );
  } catch (error) {
    if (error instanceof CrossDeviceMoveSourceCleanupError) {
      return mapCrossDeviceRecoveryFailure(error);
    }
    throw error;
  }

  return {
    success: true,
    path: input.destDisplayPath,
    sizeBytes: input.sizeBytes,
  };
}
