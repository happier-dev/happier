import { copyFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const CROSS_DEVICE_STAGING_PREFIX = '.happier-upload-stage-';
const CROSS_DEVICE_BACKUP_PREFIX = '.happier-upload-backup-';
const FALLBACK_MOVE_ERROR_CODES = new Set(['EXDEV', 'EEXIST', 'EPERM']);

export class CrossDeviceMoveSourceCleanupError extends Error {
    readonly sourcePath: string;
    readonly destPath: string;
    readonly destinationRolledBack: boolean;

    constructor(input: Readonly<{
        sourcePath: string;
        destPath: string;
        destinationRolledBack: boolean;
        cause: unknown;
    }>) {
        super(
            input.destinationRolledBack
                ? 'Failed to clean up the staged upload source after cross-device copy; destination was rolled back'
                : 'Failed to clean up the staged upload source after cross-device copy and destination rollback failed',
            { cause: input.cause },
        );
        this.name = 'CrossDeviceMoveSourceCleanupError';
        this.sourcePath = input.sourcePath;
        this.destPath = input.destPath;
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

async function removeFile(path: string): Promise<void> {
    await rm(path, { force: true });
}

async function moveExistingDestinationAside(destPath: string): Promise<string | null> {
    const backupPath = join(
        dirname(destPath),
        `${CROSS_DEVICE_BACKUP_PREFIX}${basename(destPath)}.${randomUUID()}.tmp`,
    );

    try {
        await rename(destPath, backupPath);
        return backupPath;
    } catch (error) {
        if (readErrorCode(error) === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

async function restoreExistingDestination(backupPath: string, destPath: string): Promise<void> {
    await removeFile(destPath).catch(() => undefined);
    await rename(backupPath, destPath);
}

export async function moveFileWithCrossDeviceFallback(sourcePath: string, destPath: string): Promise<void> {
    try {
        await rename(sourcePath, destPath);
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
        backupDestPath = await moveExistingDestinationAside(destPath);
        await copyFile(sourcePath, stagedDestPath);
        await rename(stagedDestPath, destPath);
    } catch (error) {
        await removeFile(stagedDestPath).catch(() => undefined);
        if (backupDestPath !== null) {
            await rename(backupDestPath, destPath).catch(() => undefined);
        }
        throw error;
    }

    try {
        await removeFile(sourcePath);
    } catch (error) {
        try {
            if (backupDestPath !== null) {
                await restoreExistingDestination(backupDestPath, destPath);
            } else {
                await removeFile(destPath);
            }
        } catch (rollbackError) {
            throw new CrossDeviceMoveSourceCleanupError({
                sourcePath,
                destPath,
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
            destinationRolledBack: true,
            cause: error,
        });
    }

    if (backupDestPath !== null) {
        await removeFile(backupDestPath).catch(() => undefined);
    }
}
