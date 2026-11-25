import { lstat, realpath, statfs } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { StoragePathCapacityV1 } from '@happier-dev/protocol/storage/storageV1';
import { canonicalAbsolutePathsEqual, expandHomeDirPath, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

type Volume = Readonly<{ id: string; label: string; mount: string }>;
export type StorageFilesystemCapacityReader = (path: string) => Promise<Readonly<{
    bavail: number | bigint; bsize: number | bigint; blocks?: number | bigint;
}>>;

/** One mount identity owner for demand reads and Storage projections. */
export function storageVolumeForPath<T extends Volume>(volumes: readonly T[], path: string): T | undefined {
    let selected: T | undefined;
    for (const volume of volumes) {
        if ((canonicalAbsolutePathsEqual(path, volume.mount) || isCanonicalAbsolutePathInsideRoot(volume.mount, path))
            && (!selected || volume.mount.length > selected.mount.length)) selected = volume;
    }
    return selected;
}

function filesystemErrorCode(error: unknown): string | undefined {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
}

async function resolveCapacityPath(path: string, allowMissingPath: boolean): Promise<string> {
    let candidate = path;
    for (;;) {
        try {
            return await realpath(candidate);
        } catch (error) {
            const parent = dirname(candidate);
            if (!allowMissingPath || filesystemErrorCode(error) !== 'ENOENT' || parent === candidate) throw error;
            try {
                // A dangling symlink is an existing entry. Its filesystem is not the intended destination.
                await lstat(candidate);
                throw error;
            } catch (lookupError) {
                if (lookupError === error || filesystemErrorCode(lookupError) !== 'ENOENT') throw lookupError;
            }
            candidate = parent;
        }
    }
}

/** Capacity on the selected filesystem, or on the closest existing parent for a new destination. */
export async function readStoragePathCapacity(path: string, deps: Readonly<{
    readVolumes(): readonly Volume[];
    allowMissingPath?: boolean;
    readFilesystemCapacity?: StorageFilesystemCapacityReader;
    nowMs?: () => number;
}>): Promise<StoragePathCapacityV1 & Readonly<{ totalBytes?: number }>> {
    let selectedPath = expandHomeDirPath(path);
    if (!isAbsolute(selectedPath)) return { status: 'unknown', path: selectedPath, reason: 'path_not_absolute' };
    const readFilesystemCapacity: StorageFilesystemCapacityReader = deps.readFilesystemCapacity
        ?? (value => statfs(value, { bigint: true }));
    try {
        selectedPath = await resolveCapacityPath(selectedPath, deps.allowMissingPath === true);
        const facts = await readFilesystemCapacity(selectedPath);
        const freeBytes = Number(BigInt(facts.bavail) * BigInt(facts.bsize));
        if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
            return { status: 'unknown', path: selectedPath, reason: 'capacity_unrepresentable' };
        }
        const totalBytes = facts.blocks === undefined ? undefined : Number(BigInt(facts.blocks) * BigInt(facts.bsize));
        const volume = storageVolumeForPath(deps.readVolumes(), selectedPath);
        return { status: 'known', path: selectedPath, freeBytes,
            ...(totalBytes !== undefined && Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? { totalBytes } : {}), observedAt: (deps.nowMs ?? Date.now)(),
            ...(volume ? { volume: { volumeId: volume.id, mountPath: volume.mount, label: volume.label } } : {}) };
    } catch (error) {
        const reason = filesystemErrorCode(error) ?? 'capacity_unavailable';
        return { status: 'unknown', path: selectedPath, reason };
    }
}
