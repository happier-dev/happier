import { lstat, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type { HappierStorageCategoryIdV1, StorageReadIssueV1 } from '@happier-dev/protocol/storage/storageV1';
import type { StorageCategoryContext, StorageCategoryItem, StorageCategoryVerdict } from './types';
import { physicalStoragePathWithoutFollowingLeaf, realStoragePathWithAbsentSuffix, storagePathContains, storagePathsEqual, storagePathDirname, storagePathLeaf, storagePathJoin, storagePathToFs } from '../storagePath';

type PermissionProjection = (path: string) => void;
export function unavailableDirectory(context: Pick<StorageCategoryContext, 'discoveryIssues'>, categoryId: HappierStorageCategoryIdV1): PermissionProjection {
    return path => {
        if (!context.discoveryIssues.some(value => value.categoryId === categoryId && value.path === path))
            context.discoveryIssues.push(item(categoryId, path, check, { evidence: ['directory_permission_unavailable'] }));
    };
}
export function isPermissionError(error: unknown): boolean {
    return error !== null && typeof error === 'object' && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM');
}
export function storagePermissionReadIssue(categoryId: HappierStorageCategoryIdV1): StorageReadIssueV1 {
    return { categoryId, reason: 'permission_denied', remedy: 'grant_admin_access_or_run_as_machine_owner' };
}
export async function entries(root: string, onPermissionDenied?: PermissionProjection, scope?: readonly string[]): Promise<readonly string[]> {
    try {
        if (scope) {
            const physical = await realStoragePathWithAbsentSuffix(root);
            // A selected container needs its descendants' verdicts. For an exact
            // item below it, address just that branch instead of listing siblings.
            if (!scope.some(path => storagePathContains(path, physical))) {
                const branches = new Set<string>();
                for (const path of scope) {
                    if (!storagePathContains(physical, path)) continue;
                    let child = path;
                    while (!storagePathsEqual(storagePathDirname(child), physical)) child = storagePathDirname(child);
                    branches.add(storagePathJoin(root, storagePathLeaf(child)));
                }
                const selected = await Promise.all([...branches].map(async path =>
                    await listedEntryStat(path, onPermissionDenied) ? path : null));
                return selected.filter(path => path !== null).sort();
            }
        }
        return root.startsWith('bytes:')
            ? (await readdir(storagePathToFs(root), { encoding: 'buffer' })).sort(Buffer.compare).map(name => storagePathJoin(root, name))
            : (await readdir(root)).sort().map(name => join(root, name));
    }
    catch (error) {
        if (isAbsent(error)) return [];
        if (onPermissionDenied && isPermissionError(error)) { onPermissionDenied(root); return []; }
        throw error;
    }
}
function isAbsent(error: unknown) { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
/** A listed leaf may be concurrently removed; unavailable permissions remain explicit facts. */
export async function listedEntryStat(path: string, onPermissionDenied?: PermissionProjection) {
    try { return await lstat(storagePathToFs(path)); }
    catch (error) {
        if (isAbsent(error)) return null;
        if (onPermissionDenied && isPermissionError(error)) { onPermissionDenied(path); return null; }
        throw error;
    }
}
export async function exists(path: string, onPermissionDenied?: PermissionProjection): Promise<boolean> {
    return await listedEntryStat(path, onPermissionDenied) !== null;
}
/** Owner records and native page paths may use different symlinked parents. */
export async function isCategoryPathInScope(path: string, scope?: readonly string[]): Promise<boolean> {
    if (!scope) return true;
    const physical = await physicalStoragePathWithoutFollowingLeaf(path);
    return scope.some(candidate => storagePathContains(candidate, physical) || storagePathContains(physical, candidate));
}
export function contains(root: string, path: string): boolean {
    return canonicalAbsolutePathsEqual(root, path) || isCanonicalAbsolutePathInsideRoot(root, path);
}
export function isInUse(path: string, context: StorageCategoryContext): boolean {
    return context.inUse.paths.some(live => context.pathComparator.contains(path, live) || context.pathComparator.contains(live, path))
        || (context.inUse.cwdPaths ?? []).some(cwd => context.pathComparator.contains(path, cwd) || context.pathComparator.contains(cwd, path));
}
export const check: StorageCategoryVerdict = { verdict: 'check', reason: { code: 'facts_unavailable' }, collectable: false };
export const inUse: StorageCategoryVerdict = { verdict: 'keep', reason: { code: 'in_use' }, collectable: true, loses: [{ code: 'in_use' }] };
export const safe: StorageCategoryVerdict = { verdict: 'safe', reason: { code: 'rebuilds' }, collectable: true };
/** Keep useful filenames, but describe content-addressed folders by their category owner. */
export function opaqueItemTitle(path: string, ownerTitle: string): string {
    const name = basename(path);
    return /^[a-f0-9]{64}$/iu.test(name) ? ownerTitle : name;
}
export function item(categoryId: HappierStorageCategoryIdV1, path: string, verdict: StorageCategoryVerdict,
    options: Partial<Pick<StorageCategoryItem, 'title' | 'lastChangedAt' | 'lastUsedAt' | 'evidence' | 'kind'>> = {}): StorageCategoryItem {
    return { itemId: createHash('sha256').update(`${categoryId}\0${path}`).digest('hex'),
        kind: 'category-item', categoryId, path, title: basename(path), evidence: [], ...verdict, ...options };
}
export async function directoriesAtDepth(root: string, depth: number, onPermissionDenied?: PermissionProjection, scope?: readonly string[]): Promise<readonly string[]> {
    if (depth === 0) return await listedEntryStat(root, onPermissionDenied) ? [root] : [];
    const result: string[] = [];
    for (const path of await entries(root, onPermissionDenied, scope)) {
        const stat = await listedEntryStat(path, onPermissionDenied);
        if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
        result.push(...await directoriesAtDepth(path, depth - 1, onPermissionDenied, scope));
    }
    return result;
}

/** Temporary ownership's reboot proof requires the newest descendant change, not the parent mtime. */
export async function newestChange(path: string): Promise<number | null> {
    try {
        const stat = await lstat(path);
        let newest = stat.mtimeMs;
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
            for (const child of await entries(path)) {
                const changed = await newestChange(child);
                if (changed === null) return null;
                newest = Math.max(newest, changed);
            }
        }
        return newest;
    } catch { return null; }
}
