/**
 * Source-control status file-level functionality.
 * Uses the canonical working snapshot as single source of truth.
 */

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

import { isDirectoryLikeScmFileStatus } from './isDirectoryLikeScmFileStatus';

export interface ScmFileStatus {
    fileName: string;
    filePath: string;
    fullPath: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
    isIncluded: boolean;
    /** Snapshot fact, independent of the area this status row represents. */
    hasIncludedDelta?: boolean;
    linesAdded: number;
    linesRemoved: number;
    oldPath?: string;
    isBinary?: boolean;
    isComplete?: boolean;
}

export interface ScmStatusFiles {
    includedFiles: ScmFileStatus[];
    pendingFiles: ScmFileStatus[];
    changeSetModel?: 'index' | 'working-copy';
    branch: string | null;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    detached?: boolean;
    totalIncluded: number;
    totalPending: number;
}

const snapshotStatusFilesCache = new WeakMap<ScmWorkingSnapshot, ScmStatusFiles>();
const snapshotChangedFilesCache = new WeakMap<ScmWorkingSnapshot, readonly ScmFileStatus[]>();

function toFileStatus(entry: ScmWorkingEntry, isIncluded: boolean): ScmFileStatus {
    const segments = entry.path.split('/');
    const fileName = segments[segments.length - 1] || entry.path;
    const filePath = segments.slice(0, -1).join('/');

    return {
        fileName,
        filePath,
        fullPath: entry.path,
        status: entry.kind,
        isIncluded,
        hasIncludedDelta: entry.hasIncludedDelta,
        linesAdded: isIncluded ? entry.stats.includedAdded : entry.stats.pendingAdded,
        linesRemoved: isIncluded ? entry.stats.includedRemoved : entry.stats.pendingRemoved,
        oldPath: entry.previousPath ?? undefined,
        isBinary: entry.stats.isBinary,
        ...(entry.stats.isComplete === undefined ? {} : { isComplete: entry.stats.isComplete }),
    };
}

export function snapshotToScmStatusFiles(snapshot: ScmWorkingSnapshot): ScmStatusFiles {
    const cached = snapshotStatusFilesCache.get(snapshot);
    if (cached) return cached;

    const includedFiles = snapshot.entries
        .filter((entry) => entry.hasIncludedDelta)
        .map((entry) => toFileStatus(entry, true));

    const pendingFiles = snapshot.entries
        .filter((entry) => entry.hasPendingDelta)
        .map((entry) => toFileStatus(entry, false));

    const result: ScmStatusFiles = {
        includedFiles,
        pendingFiles,
        changeSetModel: snapshot.capabilities?.changeSetModel ?? 'index',
        branch: snapshot.branch.head,
        upstream: snapshot.branch.upstream,
        ahead: snapshot.branch.ahead,
        behind: snapshot.branch.behind,
        detached: snapshot.branch.detached,
        totalIncluded: includedFiles.length,
        totalPending: pendingFiles.length,
    };

    snapshotStatusFilesCache.set(snapshot, result);
    return result;
}

/**
 * The working copy's changed files: one row per changed path (a file staged and then edited again is
 * one file), untracked files included, and directories collapsed by the backend (`scratch/`) left
 * out because they are not a file a person can open, stage or commit. Sorted by path.
 *
 * This list is the one change-count truth: its length is the count on the rail badge and its tooltip,
 * the Git and Files headers, the Changes tab and the phone cockpit (`ScmStatus.changedFileCount`).
 */
export function selectScmChangedFiles(snapshot: ScmWorkingSnapshot): readonly ScmFileStatus[] {
    const cached = snapshotChangedFilesCache.get(snapshot);
    if (cached) return cached;

    const statusFiles = snapshotToScmStatusFiles(snapshot);
    const mergedByPath = new Map<string, ScmFileStatus>();
    // The pending row wins for a file in both areas: it carries the edit the person sees last.
    for (const file of [...statusFiles.pendingFiles, ...statusFiles.includedFiles]) {
        if (isDirectoryLikeScmFileStatus(file) || mergedByPath.has(file.fullPath)) continue;
        mergedByPath.set(file.fullPath, file);
    }
    const result = Array.from(mergedByPath.values()).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
    snapshotChangedFilesCache.set(snapshot, result);
    return result;
}

/**
 * The same working copy seen through one scope of its changed files (this session's changes, the files
 * selected for the next commit): the entries whose path is in `paths`. Every count read from the result
 * still goes through {@link selectScmChangedFiles}, so a scoped view (the Git tree's folders) counts
 * exactly the rows it shows.
 */
export function narrowScmSnapshotToPaths(snapshot: ScmWorkingSnapshot, paths: ReadonlySet<string>): ScmWorkingSnapshot {
    const entries = snapshot.entries.filter((entry) => paths.has(entry.path));
    return entries.length === snapshot.entries.length ? snapshot : { ...snapshot, entries };
}

/**
 * A fixed list of changed files (one turn's evidence) in the snapshot shape the changed-only tree reads,
 * so a turn is drawn by the same tree, letters and counts as the working copy. It describes those files
 * only: it carries no branch, capability or freshness fact and must never stand in for the working copy.
 */
export function projectChangedFilesAsScmSnapshot(
    files: readonly ScmFileStatus[],
    identity: Readonly<{ projectKey: string; rootPath: string | null }>,
): ScmWorkingSnapshot {
    const entries = files.map((file): ScmWorkingEntry => ({
        path: file.fullPath,
        previousPath: file.oldPath ?? null,
        kind: file.status,
        includeStatus: '',
        pendingStatus: '',
        hasIncludedDelta: false,
        hasPendingDelta: true,
        stats: {
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: Math.max(0, file.linesAdded),
            pendingRemoved: Math.max(0, file.linesRemoved),
            isBinary: file.isBinary === true,
            ...(file.isComplete === false ? { isComplete: false } : {}),
        },
    }));
    return {
        projectKey: identity.projectKey,
        fetchedAt: 0,
        repo: { isRepo: true, rootPath: identity.rootPath },
        branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: files.some((file) => file.status === 'conflicted'),
        entries,
        totals: {
            includedFiles: 0,
            pendingFiles: entries.length,
            untrackedFiles: files.filter((file) => file.status === 'untracked').length,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: entries.reduce((sum, entry) => sum + entry.stats.pendingAdded, 0),
            pendingRemoved: entries.reduce((sum, entry) => sum + entry.stats.pendingRemoved, 0),
        },
    };
}

/** Paths in conflict, ready for the existing file-open action in the Git and Review panes. */
export function selectScmConflictFiles(snapshot: ScmWorkingSnapshot): readonly Readonly<{ path: string; openPath: string }>[] {
    return selectScmChangedFiles(snapshot)
        .filter((file) => file.status === 'conflicted')
        .map((file) => ({ path: file.fullPath, openPath: file.fullPath }));
}
