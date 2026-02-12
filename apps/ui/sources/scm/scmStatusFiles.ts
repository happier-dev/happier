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
    linesAdded: number;
    linesRemoved: number;
    oldPath?: string;
    isBinary?: boolean;
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
        linesAdded: isIncluded ? entry.stats.includedAdded : entry.stats.pendingAdded,
        linesRemoved: isIncluded ? entry.stats.includedRemoved : entry.stats.pendingRemoved,
        oldPath: entry.previousPath ?? undefined,
        isBinary: entry.stats.isBinary,
    };
}

export function snapshotToScmStatusFiles(snapshot: ScmWorkingSnapshot): ScmStatusFiles {
    const includedFiles = snapshot.entries
        .filter((entry) => entry.hasIncludedDelta)
        .map((entry) => toFileStatus(entry, true));

    const pendingFiles = snapshot.entries
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
