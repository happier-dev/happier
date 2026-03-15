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
    // Prefer the unique entry list when available (avoids double-counting partially-staged files),
    // but fall back to totals when the entry list is not present (or temporarily empty).
    const changedFiles = typeof entryCount === 'number' && entryCount > 0 ? entryCount : totalsChangedFiles;
    const hasAnyChanges = changedFiles > 0;

    return {
        branch: snapshot.branch.head,
        upstream: snapshot.branch.upstream,
        ahead: snapshot.branch.ahead,
        behind: snapshot.branch.behind,
        changedFiles,
        linesAdded,
        linesRemoved,
        hasLineChanges: linesAdded > 0 || linesRemoved > 0,
        hasAnyChanges,
    };
}
