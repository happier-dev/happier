import type { GitWorkingSnapshot } from '../../domains/state/storageTypes';

export function canRevertFromSnapshot(snapshot: GitWorkingSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    if (snapshot.hasConflicts) return false;
    if (snapshot.totals.stagedFiles > 0) return false;
    if (snapshot.totals.unstagedFiles > 0) return false;
    return true;
}

export function canCreateCommitFromSnapshot(snapshot: GitWorkingSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    if (snapshot.hasConflicts) return false;
    return snapshot.totals.stagedFiles > 0;
}

export function canPullFromSnapshot(snapshot: GitWorkingSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    if (snapshot.hasConflicts) return false;
    if (!snapshot.branch.head || !snapshot.branch.upstream) return false;
    if (snapshot.totals.stagedFiles > 0) return false;
    if (snapshot.totals.unstagedFiles > 0) return false;
    return true;
}

export function canPushFromSnapshot(snapshot: GitWorkingSnapshot | null | undefined): boolean {
    if (!snapshot) return false;
    if (snapshot.hasConflicts) return false;
    if (!snapshot.branch.head || !snapshot.branch.upstream) return false;
    return true;
}
