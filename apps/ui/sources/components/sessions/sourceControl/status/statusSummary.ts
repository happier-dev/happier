import { selectScmChangedFileCount, selectScmChangedFiles, selectScmSnapshotLineTotals, type ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

/**
 * What the session surfaces say about a working copy at a glance (the composer's Git instrument,
 * the status badges, the Companion summary): where it is, how many files changed and by how much.
 * Not the SCM backend's `ScmStatusSummary` (included/pending/untracked areas); the changed-file count
 * is the one change-count truth, `selectScmChangedFiles`.
 */
export type SessionScmSummary = {
    branch: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    changedFiles: number;
    linesAdded: number;
    linesRemoved: number;
    hasLineChanges: boolean;
    isComplete?: boolean;
    hasAnyChanges: boolean;
};

export type SessionScmChangesSummary = SessionScmSummary & Readonly<{
    files: readonly ScmFileStatus[];
    fetchedAt: number;
}>;

const NO_FILES: readonly ScmFileStatus[] = [];

/** The lines these files add and remove, however many of a working copy's files they are. */
export function sumChangedLines(files: readonly ScmFileStatus[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const file of files) {
        added += Number.isFinite(file.linesAdded) ? Math.max(0, file.linesAdded) : 0;
        removed += Number.isFinite(file.linesRemoved) ? Math.max(0, file.linesRemoved) : 0;
    }
    return { added, removed };
}

export function buildSessionScmSummary(snapshot: ScmWorkingSnapshot | null): SessionScmChangesSummary | null {
    // A facts delivery measured no working copy: it has nothing to summarize.
    if (!snapshot?.repo.isRepo || snapshot.detail === 'facts') {
        return null;
    }

    const totals = selectScmSnapshotLineTotals(snapshot);
    const linesAdded = totals.includedAdded + totals.pendingAdded;
    const linesRemoved = totals.includedRemoved + totals.pendingRemoved;
    // A summary delivery carries counts, not rows: `files` stays empty and never reads as clean.
    const files = snapshot.detail === 'summary' ? NO_FILES : selectScmChangedFiles(snapshot);
    const changedFiles = selectScmChangedFileCount(snapshot);

    return {
        branch: snapshot.branch.head,
        upstream: snapshot.branch.upstream,
        ahead: snapshot.branch.ahead,
        behind: snapshot.branch.behind,
        changedFiles,
        ...(snapshot.totals.isComplete === undefined ? {} : { isComplete: snapshot.totals.isComplete }),
        linesAdded,
        linesRemoved,
        hasLineChanges: linesAdded > 0 || linesRemoved > 0,
        hasAnyChanges: changedFiles > 0,
        files,
        fetchedAt: snapshot.fetchedAt,
    };
}
