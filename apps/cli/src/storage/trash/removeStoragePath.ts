import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { physicalStoragePathWithoutFollowingLeaf, realStoragePathWithAbsentSuffix, storageAbsolutePath, storagePathContains,
    storagePathJoin, storagePathsEqual, storagePathToFs } from '../storagePath';

export type StoragePathIdentity = Readonly<{ dev: string; ino: string; kind: 'file' | 'directory' | 'symlink' | 'other' }>;
export async function readStoragePathIdentity(path: string): Promise<StoragePathIdentity> {
    const stat = await lstat(storagePathToFs(path), { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino), kind: stat.isSymbolicLink() ? 'symlink'
        : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' };
}
export function storagePathIdentitiesEqual(left: StoragePathIdentity, right: StoragePathIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}
export async function assertStoragePathIdentity(path: string, expected: StoragePathIdentity): Promise<void> {
    if (!storagePathIdentitiesEqual(await readStoragePathIdentity(path), expected)) {
        throw Object.assign(new Error('Storage path changed'), { code: 'changed_since_review' });
    }
}
async function restoreOwnerPermissions(path: string, beforeEffect?: () => Promise<void>): Promise<void> {
    const stat = await lstat(storagePathToFs(path));
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
        if (process.platform === 'win32' || stat.uid === process.getuid?.()) { await beforeEffect?.(); await chmod(storagePathToFs(path), stat.mode | 0o700); }
        for (const child of await readdir(storagePathToFs(path), { encoding: 'buffer' })) await restoreOwnerPermissions(storagePathJoin(path, child), beforeEffect);
    } else if (process.platform === 'win32') {
        // Node's Windows chmod writable bit clears FILE_ATTRIBUTE_READONLY.
        await beforeEffect?.(); await chmod(storagePathToFs(path), stat.mode | 0o200);
    }
}
/** Shared deletion owner for Trash Empty and storage Delete now; links remain leaves. */
export async function removeStoragePath(path: string, input: Readonly<{
    allowedRoot: string; expectedIdentity: StoragePathIdentity; beforeEffect?: () => Promise<void>;
}>): Promise<void> {
    const physical = await physicalStoragePathWithoutFollowingLeaf(storageAbsolutePath(path));
    const root = await realStoragePathWithAbsentSuffix(input.allowedRoot);
    if (storagePathsEqual(physical, root) || !storagePathContains(root, physical)) {
        throw Object.assign(new Error('Removal escaped its owning root'), { code: 'storage_path_outside_owner' });
    }
    await assertStoragePathIdentity(physical, input.expectedIdentity);
    await input.beforeEffect?.();
    // Authority can wait on Home. Keep its returned permission bound to the
    // original filesystem object if the path was replaced during that wait.
    await assertStoragePathIdentity(physical, input.expectedIdentity);
    // A reviewed leaf must never recursively remove a directory substituted
    // after the last identity check at the OS boundary.
    const recursive = input.expectedIdentity.kind === 'directory';
    try { await rm(storagePathToFs(physical), { recursive, force: true }); }
    catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'ENOTEMPTY' && !(process.platform === 'win32' && code === 'EPERM')) throw error;
        await assertStoragePathIdentity(physical, input.expectedIdentity);
        await restoreOwnerPermissions(physical, input.beforeEffect);
        await assertStoragePathIdentity(physical, input.expectedIdentity);
        await input.beforeEffect?.();
        await assertStoragePathIdentity(physical, input.expectedIdentity);
        await rm(storagePathToFs(physical), { recursive, force: true });
    }
    try { await lstat(storagePathToFs(physical)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    throw Object.assign(new Error('Storage removal left a path behind'), { code: 'storage_removal_incomplete' });
}
