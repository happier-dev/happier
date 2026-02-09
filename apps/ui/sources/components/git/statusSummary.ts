import type { GitWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type GitStatusSummary = {
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

export function buildGitStatusSummaryFromSnapshot(snapshot: GitWorkingSnapshot | null): GitStatusSummary | null {
    if (!snapshot?.repo.isGitRepo) {
        return null;
    }

    const linesAdded = snapshot.totals.stagedAdded + snapshot.totals.unstagedAdded;
    const linesRemoved = snapshot.totals.stagedRemoved + snapshot.totals.unstagedRemoved;
    const changedFiles = snapshot.totals.stagedFiles + snapshot.totals.unstagedFiles + snapshot.totals.untrackedFiles;
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
