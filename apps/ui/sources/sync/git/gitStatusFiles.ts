/**
 * Git status file-level functionality
 * Uses the canonical Git working snapshot as single source of truth.
 */

import type { GitWorkingEntry, GitWorkingSnapshot } from '../domains/state/storageTypes';

export interface GitFileStatus {
    fileName: string;
    filePath: string;
    fullPath: string;
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';
    isStaged: boolean;
    linesAdded: number;
    linesRemoved: number;
    oldPath?: string;
    isBinary?: boolean;
}

export interface GitStatusFiles {
    stagedFiles: GitFileStatus[];
    unstagedFiles: GitFileStatus[];
    branch: string | null;
    upstream?: string | null;
    ahead?: number;
    behind?: number;
    detached?: boolean;
    totalStaged: number;
    totalUnstaged: number;
}

function toFileStatus(entry: GitWorkingEntry, isStaged: boolean): GitFileStatus {
    const segments = entry.path.split('/');
    const fileName = segments[segments.length - 1] || entry.path;
    const filePath = segments.slice(0, -1).join('/');

    return {
        fileName,
        filePath,
        fullPath: entry.path,
        status: entry.kind,
        isStaged,
        linesAdded: isStaged ? entry.stats.stagedAdded : entry.stats.unstagedAdded,
        linesRemoved: isStaged ? entry.stats.stagedRemoved : entry.stats.unstagedRemoved,
        oldPath: entry.previousPath ?? undefined,
        isBinary: entry.stats.isBinary,
    };
}

export function snapshotToGitStatusFiles(snapshot: GitWorkingSnapshot): GitStatusFiles {
    const stagedFiles = snapshot.entries
        .filter((entry) => entry.hasStagedDelta)
        .map((entry) => toFileStatus(entry, true));

    const unstagedFiles = snapshot.entries
        .filter((entry) => entry.hasUnstagedDelta)
        .map((entry) => toFileStatus(entry, false));

    return {
        stagedFiles,
        unstagedFiles,
        branch: snapshot.branch.head,
        upstream: snapshot.branch.upstream,
        ahead: snapshot.branch.ahead,
        behind: snapshot.branch.behind,
        detached: snapshot.branch.detached,
        totalStaged: stagedFiles.length,
        totalUnstaged: unstagedFiles.length,
    };
}
