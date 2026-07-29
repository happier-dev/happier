import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { WorkspaceFinalizeFileOperationsFactory } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';

export const STACK_TRANSFER_RECOVERY_TESTKIT_ENABLE_ENV =
    'HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT';
export const STACK_TRANSFER_RECOVERY_TESTKIT_AUTHORITY_ENV =
    'HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT_AUTHORITY';
export const STACK_TRANSFER_RECOVERY_TESTKIT_ARM_FILE_ENV =
    'HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT_ARM_FILE';

const AUTHORITY_MIN_CHARS = 32;
const ARM_VERSION = 1;
const FAULT_KIND = 'finalize_recovery_required_once';

type Environment = Readonly<Record<string, string | undefined>>;

function isPathInside(parentPath: string, candidatePath: string): boolean {
    const child = relative(parentPath, candidatePath);
    return child.length > 0 && !child.startsWith('..') && !isAbsolute(child);
}

export function hashTransferRecoveryTestkitDestination(destinationPath: string): string {
    return createHash('sha256').update(resolve(destinationPath)).digest('hex');
}

function parseArmRecord(raw: string): Readonly<{
    authority: string;
    destinationPathSha256: string;
}> | null {
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }
        const record = value as Record<string, unknown>;
        if (
            Object.keys(record).some((key) => ![
                'v',
                'authority',
                'fault',
                'destinationPathSha256',
            ].includes(key))
            || record.v !== ARM_VERSION
            || record.fault !== FAULT_KIND
            || typeof record.authority !== 'string'
            || typeof record.destinationPathSha256 !== 'string'
            || !/^[a-f0-9]{64}$/.test(record.destinationPathSha256)
        ) {
            return null;
        }
        return {
            authority: record.authority,
            destinationPathSha256: record.destinationPathSha256,
        };
    } catch {
        return null;
    }
}

function resolveArmFile(env: Environment): Readonly<{
    armFile: string;
    authority: string;
}> | null {
    if (
        env.NODE_ENV === 'production'
        || env.HAPPIER_STACK_PROCESS_KIND !== 'daemon'
        || !env.HAPPIER_STACK_STACK
        || !env.HAPPIER_STACK_REPO_DIR
        || env[STACK_TRANSFER_RECOVERY_TESTKIT_ENABLE_ENV] !== '1'
    ) {
        return null;
    }
    const authority = env[STACK_TRANSFER_RECOVERY_TESTKIT_AUTHORITY_ENV]?.trim() ?? '';
    const runtimeDirRaw = env.HAPPIER_STACK_RUNTIME_DIR?.trim() ?? '';
    const armFileRaw = env[STACK_TRANSFER_RECOVERY_TESTKIT_ARM_FILE_ENV]?.trim() ?? '';
    if (
        authority.length < AUTHORITY_MIN_CHARS
        || !isAbsolute(runtimeDirRaw)
        || !isAbsolute(armFileRaw)
    ) {
        return null;
    }
    const runtimeDir = resolve(runtimeDirRaw);
    const armFile = resolve(armFileRaw);
    return isPathInside(runtimeDir, armFile)
        ? { armFile, authority }
        : null;
}

export function resolveStackTransferFinalizeRecoveryFault(
    env: Environment = process.env,
): WorkspaceFinalizeFileOperationsFactory | null {
    const configuration = resolveArmFile(env);
    if (!configuration) {
        return null;
    }

    return ({ uploadId, tempPath, destPath }) => {
        let armRecord: ReturnType<typeof parseArmRecord>;
        try {
            armRecord = parseArmRecord(readFileSync(configuration.armFile, 'utf8'));
        } catch {
            return null;
        }
        if (
            !armRecord
            || armRecord.authority !== configuration.authority
            || armRecord.destinationPathSha256
                !== hashTransferRecoveryTestkitDestination(destPath)
        ) {
            return null;
        }

        const claimFile = `${configuration.armFile}.${process.pid}.${randomUUID()}.claimed`;
        try {
            renameSync(configuration.armFile, claimFile);
        } catch {
            return null;
        }
        try {
            const claimedRecord = parseArmRecord(readFileSync(claimFile, 'utf8'));
            if (
                !claimedRecord
                || claimedRecord.authority !== configuration.authority
                || claimedRecord.destinationPathSha256
                    !== hashTransferRecoveryTestkitDestination(destPath)
            ) {
                return null;
            }
        } finally {
            rmSync(claimFile, { force: true });
        }

        const exactTempPath = resolve(tempPath);
        const exactDestPath = resolve(destPath);
        let forcedInitialFallback = false;
        let forcedSourceCleanupFailure = false;

        return {
            copyFile: async (sourcePath, destinationPath, mode) => {
                await copyFile(sourcePath, destinationPath, mode);
            },
            rename: async (sourcePath, destinationPath) => {
                const normalizedSource = resolve(sourcePath);
                const normalizedDestination = resolve(destinationPath);
                if (
                    !forcedInitialFallback
                    && normalizedSource === exactTempPath
                    && normalizedDestination === exactDestPath
                ) {
                    forcedInitialFallback = true;
                    const error = new Error(
                        `Stack transfer recovery testkit forced exact-upload fallback for ${uploadId}`,
                    ) as NodeJS.ErrnoException;
                    error.code = 'EXDEV';
                    throw error;
                }
                if (
                    forcedSourceCleanupFailure
                    && normalizedDestination === exactDestPath
                    && normalizedSource.includes('.happier-upload-backup-')
                ) {
                    const error = new Error(
                        `Stack transfer recovery testkit forced exact-upload restore failure for ${uploadId}`,
                    ) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                await rename(sourcePath, destinationPath);
            },
            rm: async (path, options) => {
                const normalizedPath = resolve(path);
                if (
                    forcedInitialFallback
                    && !forcedSourceCleanupFailure
                    && normalizedPath === exactTempPath
                ) {
                    forcedSourceCleanupFailure = true;
                    const error = new Error(
                        `Stack transfer recovery testkit forced exact-upload source cleanup failure for ${uploadId}`,
                    ) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                if (
                    forcedSourceCleanupFailure
                    && normalizedPath === exactDestPath
                ) {
                    const error = new Error(
                        `Stack transfer recovery testkit forced exact-upload destination rollback failure for ${uploadId}`,
                    ) as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                await rm(path, options);
            },
        };
    };
}
