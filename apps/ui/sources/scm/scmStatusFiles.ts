/**
 * Source-control status file-level functionality.
 * Uses the canonical working snapshot as single source of truth.
 */

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

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
    /**
     * True on a collapsed untracked-directory row (opt-in `'normal'`-mode
     * snapshots). Directory rows are non-actionable for per-file operations
     * (diff/discard act on file paths) — see isDirectoryLikeScmFileStatus.
     */
    isDirectory?: boolean;
    /** Untracked FILE count under a collapsed directory row. */
    untrackedFileCount?: number;
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

function toFileStatus(entry: ScmWorkingEntry, isIncluded: boolean): ScmFileStatus {
    // Collapsed directory entries carry their own name; do not run them
    // through the file-segment split (a 'D/' path would render as name 'D/'
    // inside folder 'D' — malformed).
    const isDirectory = entry.isDirectory === true;
    const displayPath = isDirectory && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path;
    const segments = displayPath.split('/');
    const fileName = segments[segments.length - 1] || displayPath;
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
        ...(isDirectory ? { isDirectory: true } : {}),
        ...(entry.untrackedFileCount === undefined ? {} : { untrackedFileCount: entry.untrackedFileCount }),
    };
}

function buildScmStatusFiles(entries: readonly ScmWorkingEntry[], snapshot: ScmWorkingSnapshot): ScmStatusFiles {
    const includedFiles = entries
        .filter((entry) => entry.hasIncludedDelta)
        .map((entry) => toFileStatus(entry, true));

    const pendingFiles = entries
        .filter((entry) => entry.hasPendingDelta)
        .map((entry) => toFileStatus(entry, false));

    return {
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
}

/**
 * Row projection from an EXPLICIT entry list — the Files surface's bounded
 * entries window (or a snapshot's fallback rows). Same projection owner as
 * `snapshotToScmStatusFiles`; only the entry source differs.
 */
export function buildScmStatusFilesFromEntries(entries: readonly ScmWorkingEntry[], snapshot: ScmWorkingSnapshot): ScmStatusFiles {
    return buildScmStatusFiles(entries, snapshot);
}

export function snapshotToScmStatusFiles(snapshot: ScmWorkingSnapshot): ScmStatusFiles {
    const cached = snapshotStatusFilesCache.get(snapshot);
    if (cached) return cached;

    const result = buildScmStatusFiles(snapshot.entries, snapshot);
    snapshotStatusFilesCache.set(snapshot, result);
    return result;
}
