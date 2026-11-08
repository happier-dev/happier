import type { ScmFileStatus } from './scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmPathHasLineDelta, summarizeScmChanges } from '@happier-dev/protocol/scm';

export type ScmSnapshotLineTotals = Readonly<Pick<ScmWorkingSnapshot['totals'], 'includedAdded' | 'includedRemoved' | 'pendingAdded' | 'pendingRemoved'>>;

/** The shared counting owner decides which paths carry review line statistics. */
export function scmChangeHasLineDelta(file: Pick<ScmFileStatus, 'fullPath' | 'isBinary'>): boolean {
    return scmPathHasLineDelta({ path: file.fullPath, isBinary: file.isBinary });
}

/**
 * The snapshot's two-area totals minus entries with no meaningful line delta. Summary and paged deliveries
 * carries the producer's result of the same shared function.
 */
export function scmSnapshotLineTotals(snapshot: ScmWorkingSnapshot): ScmSnapshotLineTotals {
    const summary = (snapshot.detail === 'summary' || snapshot.entriesPage) && snapshot.summary
        ? snapshot.summary
        : summarizeScmChanges(snapshot.entries, snapshot.totals);
    const { includedAdded, includedRemoved, pendingAdded, pendingRemoved } = summary;
    return { includedAdded, includedRemoved, pendingAdded, pendingRemoved };
}
