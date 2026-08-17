import { lstat, mkdir, mkdtemp, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmOperationErrorCode,
  type ScmRepositoryCloneInput,
  type ScmRepositoryCloneOutput,
} from '@happier-dev/plugin-sdk/scm';

const PRIVATE_CLONE_DIRECTORY_PREFIX = '.happier-clone-';
const PUBLISH_RESERVATION_MARKER_PREFIX = '.happier-clone-publish-';

export type DestinationPreflightResult =
    | Readonly<{ ok: true; parentPath: string; parentIdentity: FileIdentity; destinationPath: string }>
    | Readonly<{ ok: false; response: ScmRepositoryCloneOutput }>;

export type CloneDestinationReservation =
    | Readonly<{
        ok: true;
        parentPath: string;
        finalDestinationPath: string;
        cloneDestinationPath: string;
        privateTempPath: string;
        privateTempIdentity: FileIdentity;
    }>
    | Readonly<{ ok: false; response: ScmRepositoryCloneOutput }>;

export type ClonePublishResult =
    | Readonly<{ ok: true; destinationIdentity: FileIdentity }>
    | Readonly<{ ok: false; response: ScmRepositoryCloneOutput }>;

export type FileIdentity = Readonly<{
    dev: number;
    ino: number;
}>;

type FinalReservation = Readonly<{
    path: string;
    identity: FileIdentity;
    markerPath: string;
    markerIdentity: FileIdentity;
}>;

type MovedCloneEntry = Readonly<{
    name: string;
    finalPath: string;
    identity: FileIdentity;
}>;

export function cloneErrorResponse(
    error: string,
    errorCode: ScmOperationErrorCode,
    extra?: Omit<Partial<Extract<ScmRepositoryCloneOutput, { success: false }>>, 'success' | 'error' | 'errorCode'>,
): ScmRepositoryCloneOutput {
    return {
        success: false,
        error,
        errorCode,
        ...extra,
    };
}

export function pathContainsTraversal(value: string): boolean {
    return value.split(/[\\/]+/).includes('..');
}

function hasUnsafePathInput(value: string): boolean {
    return value.includes('\0') || value.startsWith('~') || pathContainsTraversal(value);
}

export async function preflightDestination(request: ScmRepositoryCloneInput): Promise<DestinationPreflightResult> {
    if (!request.confirmed || request.authorizationToken !== 'clone-repository') {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone requires explicit user authorization.',
                SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
                { remediation: { kind: 'confirmation_required' } },
            ),
        };
    }

    const parentPath = resolve(request.destinationParentPath);
    if (
        !isAbsolute(request.destinationParentPath)
        || hasUnsafePathInput(request.destinationParentPath)
        || hasUnsafePathInput(request.destinationDirectoryName)
        || /[\\/]/.test(request.destinationDirectoryName)
        || request.destinationDirectoryName === '.'
        || request.destinationDirectoryName === '..'
    ) {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination must be an absolute parent path plus a safe child directory name.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    const destinationPath = resolve(parentPath, request.destinationDirectoryName);
    if (dirname(destinationPath) !== parentPath) {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination must stay inside the selected parent directory.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    let parentStats;
    try {
        parentStats = await lstat(parentPath);
    } catch {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination parent does not exist.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }
    if (parentStats.isSymbolicLink()) {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination parent must not be a symbolic link.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }
    if (!parentStats.isDirectory()) {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination parent is not a directory.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    try {
        const destinationStats = await lstat(destinationPath);
        if (destinationStats.isSymbolicLink()) {
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone destination already exists as a symbolic link.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
        return {
            ok: false,
            response: cloneErrorResponse(
                destinationStats.isDirectory()
                    ? 'Repository clone destination already exists.'
                    : 'Repository clone destination already exists and is not a directory.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    } catch (error) {
        const code = typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (code !== 'ENOENT') {
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone destination could not be inspected.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
    }

    return {
        ok: true,
        parentPath,
        parentIdentity: {
            dev: parentStats.dev,
            ino: parentStats.ino,
        },
        destinationPath,
    };
}

export async function reserveCloneDestination(
    destination: Extract<DestinationPreflightResult, { ok: true }>,
): Promise<CloneDestinationReservation> {
    try {
        if (!await isSameCloneDestination({
            path: destination.parentPath,
            identity: destination.parentIdentity,
        })) {
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone destination parent changed before private destination reservation.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
        const privateTempPath = await mkdtemp(join(
            destination.parentPath,
            `${PRIVATE_CLONE_DIRECTORY_PREFIX}${basename(destination.destinationPath)}-`,
        ));
        const privateTempStats = await lstat(privateTempPath);
        return {
            ok: true,
            parentPath: destination.parentPath,
            finalDestinationPath: destination.destinationPath,
            cloneDestinationPath: privateTempPath,
            privateTempPath,
            privateTempIdentity: {
                dev: privateTempStats.dev,
                ino: privateTempStats.ino,
            },
        };
    } catch {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone could not reserve a private clone destination.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }
}

export async function cleanupPrivateCloneDestination(input: Readonly<{
    path: string;
    identity: FileIdentity;
}>): Promise<void> {
    try {
        if (!await isSameCloneDestination(input)) return;
        await rmdir(input.path);
    } catch {
        // Best-effort cleanup only; preserve the primary clone failure.
    }
}

async function isSameCloneDestination(input: Readonly<{
    path: string;
    identity: FileIdentity;
}>): Promise<boolean> {
    const currentStats = await lstat(input.path);
    return currentStats.isDirectory()
        && !currentStats.isSymbolicLink()
        && currentStats.dev === input.identity.dev
        && currentStats.ino === input.identity.ino;
}

async function isSamePathIdentity(input: Readonly<{
    path: string;
    identity: FileIdentity;
}>): Promise<boolean> {
    const currentStats = await lstat(input.path);
    return currentStats.dev === input.identity.dev
        && currentStats.ino === input.identity.ino;
}

export async function isSameCloneDestinationOrMissing(input: Readonly<{
    path: string;
    identity: FileIdentity;
}>): Promise<boolean> {
    try {
        return await isSameCloneDestination(input);
    } catch {
        return false;
    }
}

async function cleanupFinalReservation(input: FinalReservation): Promise<void> {
    try {
        if (!await isSameCloneDestination({ path: input.path, identity: input.identity })) return;
        if (!await isSamePathIdentity({ path: input.markerPath, identity: input.markerIdentity })) return;
        await unlink(input.markerPath);
        if (!await isSameCloneDestination({ path: input.path, identity: input.identity })) return;
        await rmdir(input.path);
    } catch {
        // Best-effort cleanup only; preserve the primary publish failure.
    }
}

async function restoreMovedCloneEntries(input: Readonly<{
    privateTempPath: string;
    privateTempIdentity: FileIdentity;
    finalDestinationPath: string;
    finalDestinationIdentity: FileIdentity;
    entries: readonly MovedCloneEntry[];
}>): Promise<void> {
    for (const entry of [...input.entries].reverse()) {
        try {
            if (!await isSameCloneDestination({
                path: input.privateTempPath,
                identity: input.privateTempIdentity,
            })) continue;
            if (!await isSameCloneDestination({
                path: input.finalDestinationPath,
                identity: input.finalDestinationIdentity,
            })) continue;
            if (!await isSamePathIdentity({ path: entry.finalPath, identity: entry.identity })) continue;

            const restoredPath = join(input.privateTempPath, entry.name);
            try {
                await lstat(restoredPath);
                continue;
            } catch (error) {
                const code = typeof error === 'object' && error !== null
                    ? (error as { code?: unknown }).code
                    : undefined;
                if (code !== 'ENOENT') continue;
            }

            await rename(entry.finalPath, restoredPath);
        } catch {
            // Best-effort rollback only; never remove unknown path contents.
        }
    }
}

export async function publishPrivateCloneDestination(
    reservation: Extract<CloneDestinationReservation, { ok: true }>,
): Promise<ClonePublishResult> {
    try {
        if (!await isSameCloneDestination({
            path: reservation.privateTempPath,
            identity: reservation.privateTempIdentity,
        })) {
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone private destination changed before publish.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
    } catch {
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone private destination could not be inspected before publish.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    let finalDestinationIdentity: FileIdentity;
    let finalReservation: FinalReservation | null = null;
    const reservationMarkerPath = join(
        reservation.finalDestinationPath,
        `${PUBLISH_RESERVATION_MARKER_PREFIX}${basename(reservation.privateTempPath)}`,
    );
    try {
        await mkdir(reservation.finalDestinationPath, { recursive: false, mode: 0o700 });
        const finalDestinationStats = await lstat(reservation.finalDestinationPath);
        if (!finalDestinationStats.isDirectory() || finalDestinationStats.isSymbolicLink()) {
            await cleanupPrivateCloneDestination({
                path: reservation.privateTempPath,
                identity: reservation.privateTempIdentity,
            });
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone destination changed before publish.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
        finalDestinationIdentity = {
            dev: finalDestinationStats.dev,
            ino: finalDestinationStats.ino,
        };
        await writeFile(reservationMarkerPath, '', { flag: 'wx', mode: 0o600 });
        const markerStats = await lstat(reservationMarkerPath);
        finalReservation = {
            path: reservation.finalDestinationPath,
            identity: finalDestinationIdentity,
            markerPath: reservationMarkerPath,
            markerIdentity: {
                dev: markerStats.dev,
                ino: markerStats.ino,
            },
        };
    } catch (error) {
        const code = typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        await cleanupPrivateCloneDestination({
            path: reservation.privateTempPath,
            identity: reservation.privateTempIdentity,
        });
        return {
            ok: false,
            response: cloneErrorResponse(
                code === 'EEXIST'
                    ? 'Repository clone destination changed before publish.'
                    : 'Repository clone destination could not be reserved before publish.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }

    const movedEntries: MovedCloneEntry[] = [];
    try {
        const entries = await readdir(reservation.privateTempPath);
        for (const entry of entries) {
            if (!await isSameCloneDestination({
                path: reservation.finalDestinationPath,
                identity: finalDestinationIdentity,
            })) {
                await cleanupPrivateCloneDestination({
                    path: reservation.privateTempPath,
                    identity: reservation.privateTempIdentity,
                });
                return {
                    ok: false,
                    response: cloneErrorResponse(
                        'Repository clone destination changed after publish reservation.',
                        SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                    ),
                };
            }
            const entryDestinationPath = join(reservation.finalDestinationPath, entry);
            try {
                await lstat(entryDestinationPath);
                throw new Error('entry_exists');
            } catch (error) {
                const code = typeof error === 'object' && error !== null
                    ? (error as { code?: unknown }).code
                    : undefined;
                if (code !== 'ENOENT') throw error;
            }
            await rename(join(reservation.privateTempPath, entry), entryDestinationPath);
            const entryStats = await lstat(entryDestinationPath);
            movedEntries.push({
                name: entry,
                finalPath: entryDestinationPath,
                identity: {
                    dev: entryStats.dev,
                    ino: entryStats.ino,
                },
            });
        }
        await unlink(reservationMarkerPath);
        await rmdir(reservation.privateTempPath);
        if (!await isSameCloneDestination({
            path: reservation.finalDestinationPath,
            identity: finalDestinationIdentity,
        })) {
            return {
                ok: false,
                response: cloneErrorResponse(
                    'Repository clone destination changed after publish.',
                    SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                ),
            };
        }
        return { ok: true, destinationIdentity: finalDestinationIdentity };
    } catch {
        await restoreMovedCloneEntries({
            privateTempPath: reservation.privateTempPath,
            privateTempIdentity: reservation.privateTempIdentity,
            finalDestinationPath: reservation.finalDestinationPath,
            finalDestinationIdentity,
            entries: movedEntries,
        });
        await cleanupPrivateCloneDestination({
            path: reservation.privateTempPath,
            identity: reservation.privateTempIdentity,
        });
        if (finalReservation) {
            await cleanupFinalReservation(finalReservation);
        }
        return {
            ok: false,
            response: cloneErrorResponse(
                'Repository clone destination changed during publish.',
                SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            ),
        };
    }
}
