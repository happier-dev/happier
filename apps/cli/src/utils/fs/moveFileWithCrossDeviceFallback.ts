import { copyFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const CROSS_DEVICE_STAGING_PREFIX = '.happier-upload-stage-';
const CROSS_DEVICE_BACKUP_PREFIX = '.happier-upload-backup-';
const FALLBACK_MOVE_ERROR_CODES = new Set(['EXDEV', 'EEXIST', 'EPERM']);

export type MoveFileOperations = Readonly<{
    copyFile: (
        sourcePath: string,
        destPath: string,
        mode?: Parameters<typeof copyFile>[2],
    ) => Promise<void>;
    rename: (sourcePath: string, destPath: string) => Promise<void>;
    rm: (path: string, options?: Parameters<typeof rm>[1]) => Promise<void>;
}>;

const DEFAULT_MOVE_FILE_OPERATIONS: MoveFileOperations = {
    copyFile,
    rename,
    rm,
};

export class CrossDeviceMoveSourceCleanupError extends Error {
    readonly sourcePath: string;
    readonly destPath: string;
    readonly backupPath: string | null;
    readonly destinationRolledBack: boolean;

    constructor(input: Readonly<{
        sourcePath: string;
        destPath: string;
        backupPath: string | null;
        destinationRolledBack: boolean;
        cause: unknown;
    }>) {
        super(
            input.destinationRolledBack
                ? 'Failed to clean up the staged upload source after cross-device copy; destination was rolled back'
                : 'Cross-device file move recovery was incomplete; recovery files were preserved',
            { cause: input.cause },
        );
        this.name = 'CrossDeviceMoveSourceCleanupError';
        this.sourcePath = input.sourcePath;
        this.destPath = input.destPath;
        this.backupPath = input.backupPath;
        this.destinationRolledBack = input.destinationRolledBack;
    }
}

function readErrorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return null;
    }
    return typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null;
}

async function removeFile(path: string, operations: MoveFileOperations): Promise<void> {
    await operations.rm(path, { force: true });
}

async function moveExistingDestinationAside(
    destPath: string,
    operations: MoveFileOperations,
): Promise<string | null> {
    const backupPath = join(
        dirname(destPath),
        `${CROSS_DEVICE_BACKUP_PREFIX}${basename(destPath)}.${randomUUID()}.tmp`,
    );

    try {
        await operations.rename(destPath, backupPath);
        return backupPath;
    } catch (error) {
        if (readErrorCode(error) === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function restoreExistingDestination(
    backupPath: string,
    destPath: string,
    operations: MoveFileOperations,
): Promise<void> {
    await removeFile(destPath, operations).catch(() => undefined);
    await operations.rename(backupPath, destPath);
}

export async function moveFileWithCrossDeviceFallback(
    sourcePath: string,
    destPath: string,
    operations: MoveFileOperations = DEFAULT_MOVE_FILE_OPERATIONS,
): Promise<void> {
    try {
        await operations.rename(sourcePath, destPath);
        return;
    } catch (error) {
        if (!FALLBACK_MOVE_ERROR_CODES.has(readErrorCode(error) ?? '')) {
            throw error;
        }
    }

    const stagedDestPath = join(
        dirname(destPath),
        `${CROSS_DEVICE_STAGING_PREFIX}${basename(destPath)}.${randomUUID()}.tmp`,
    );
    let backupDestPath: string | null = null;

    try {
        backupDestPath = await moveExistingDestinationAside(destPath, operations);
        await operations.copyFile(sourcePath, stagedDestPath);
        await operations.rename(stagedDestPath, destPath);
    } catch (error) {
        await removeFile(stagedDestPath, operations).catch(() => undefined);
        if (backupDestPath !== null) {
            try {
                await operations.rename(backupDestPath, destPath);
            } catch (restorationError) {
                throw new CrossDeviceMoveSourceCleanupError({
                    sourcePath,
                    destPath,
                    backupPath: backupDestPath,
                    destinationRolledBack: false,
                    cause: new AggregateError(
                        [error, restorationError],
                        'Failed to publish the staged upload destination and restore its prior contents',
                    ),
                });
            }
        }
        throw error;
    }

    try {
        await removeFile(sourcePath, operations);
    } catch (error) {
        try {
            if (backupDestPath !== null) {
                await restoreExistingDestination(backupDestPath, destPath, operations);
            } else {
                await removeFile(destPath, operations);
            }
        } catch (rollbackError) {
            throw new CrossDeviceMoveSourceCleanupError({
                sourcePath,
                destPath,
                backupPath: backupDestPath,
                destinationRolledBack: false,
                cause: new AggregateError(
                    [error, rollbackError],
                    'Failed to clean up the staged upload source and roll back the copied destination',
                ),
            });
        }

        throw new CrossDeviceMoveSourceCleanupError({
            sourcePath,
            destPath,
            backupPath: null,
            destinationRolledBack: true,
            cause: error,
        });
    }

    if (backupDestPath !== null) {
        await removeFile(backupDestPath, operations).catch(() => undefined);
    }
}
