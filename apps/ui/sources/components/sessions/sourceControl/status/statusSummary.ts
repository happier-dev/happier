import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type ScmStatusSummary = {
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

export function buildScmStatusSummaryFromSnapshot(snapshot: ScmWorkingSnapshot | null): ScmStatusSummary | null {
    if (!snapshot?.repo.isRepo) {
        return null;
    }

    const linesAdded = snapshot.totals.includedAdded + snapshot.totals.pendingAdded;
    const linesRemoved = snapshot.totals.includedRemoved + snapshot.totals.pendingRemoved;
    const totalsChangedFiles =
        (snapshot.totals.includedFiles ?? 0)
        + (snapshot.totals.pendingFiles ?? 0)
        + (snapshot.totals.untrackedFiles ?? 0);
    const entryCount = Array.isArray(snapshot.entries) ? snapshot.entries.length : null;
    // Totals-first: totals.changedFiles is the server-derived deduplicated
    // changed-FILE count computed from the full entry set before any bounding
    // or collapsing — entries.length undercounts collapsed directories and is
    // empty under summary polls. Preserve the historical fallback order
    // (entry list, then the totals sum) for legacy snapshots.
    const changedFiles = snapshot.totals.changedFiles
        ?? (typeof entryCount === 'number' && entryCount > 0 ? entryCount : totalsChangedFiles);
    const hasAnyChanges = changedFiles > 0;

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
        hasAnyChanges,
    };
}
