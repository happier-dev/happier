import { constants } from 'fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'path';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';

import {
  CrossDeviceMoveSourceCleanupError,
  type MoveFileOperations,
} from '../../utils/fs/moveFileWithCrossDeviceFallback';
import {
  TRANSFER_FINALIZE_RECOVERY_REQUIRED_ERROR_CODE,
  type UploadTransferFinalizeResult,
} from '@happier-dev/transfers/node';

export type WorkspaceFileFinalizeOperations = MoveFileOperations & Readonly<{
  prepareCommit?: () => Promise<void>;
}>;

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
  expectedHash?: string | null;
  sha256: string;
  sizeBytes: number;
  fileOperations?: WorkspaceFileFinalizeOperations | null;
}>): Promise<UploadTransferFinalizeResult> {
  if (input.overwrite || input.expectedHash !== undefined) {
    const result = await commitGuardedFileReplace({ destPath: input.destPath, expectation: input.expectedHash,
      source: { kind: 'staged', path: input.tempPath, sha256: input.sha256 }, fileOperations: input.fileOperations ?? undefined,
      prepareCommit: input.fileOperations?.prepareCommit });
    if (result.success) return { success: true, path: input.destDisplayPath, sizeBytes: input.sizeBytes };
    const retainedSource = await stat(input.tempPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    });
    return { ...result, keepSession: retainedSource !== null };
  }
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
      return { success: false, error: 'Cannot overwrite a directory with a file', errorCode: 'EISDIR', keepSession: true };
    }
    return { success: false, error: 'Destination already exists', errorCode: 'EEXIST', keepSession: true };
  }

  const copyFileOperation = input.fileOperations?.copyFile ?? copyFile;
  const rmOperation = input.fileOperations?.rm ?? rm;
  try {
    await copyFileOperation(input.tempPath, input.destPath, constants.COPYFILE_EXCL);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
    if (code === 'EEXIST') {
      return { success: false, error: 'Destination already exists', errorCode: 'EEXIST', keepSession: true };
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
  return { success: true, path: input.destDisplayPath, sizeBytes: input.sizeBytes };
}
