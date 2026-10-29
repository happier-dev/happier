import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { buildSnapshotSignature } from '@/scm/statusSync/projectState';

// Equal status/line counts do not establish equal file contents across refreshes.
export function buildScmDiffSnapshotSignature(snapshot: ScmWorkingSnapshot, shapeSignature = buildSnapshotSignature(snapshot)): string {
    return JSON.stringify([shapeSignature, snapshot.fetchedAt]);
}

/** A file read retains repository/refresh invalidation, not the contents of unrelated status rows. */
export function buildScmFileDiffSnapshotSignature(snapshot: ScmWorkingSnapshot, entry: ScmWorkingSnapshot['entries'][number] | null): string {
    return buildScmDiffSnapshotSignature({ ...snapshot, entries: entry ? [entry] : [] });
}
