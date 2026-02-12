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
    const changedFiles = snapshot.totals.includedFiles + snapshot.totals.pendingFiles + snapshot.totals.untrackedFiles;
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
