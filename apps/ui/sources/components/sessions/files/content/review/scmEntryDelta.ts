import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function totalsChangedLines(snapshot: ScmWorkingSnapshot | null, area: ScmDiffArea): number {
    const totals = snapshot?.totals;
    if (!totals) return 0;
    if (area === 'included') return totals.includedAdded + totals.includedRemoved;
    if (area === 'pending') return totals.pendingAdded + totals.pendingRemoved;
    return totals.includedAdded + totals.includedRemoved + totals.pendingAdded + totals.pendingRemoved;
}

export type ScmEntryDelta = Readonly<{
    hasIncludedDelta: boolean;
    hasPendingDelta: boolean;
    includedAdded: number;
    includedRemoved: number;
    pendingAdded: number;
    pendingRemoved: number;
}>;

export function entryToDelta(entry: any): ScmEntryDelta {
    return {
        hasIncludedDelta: Boolean(entry?.hasIncludedDelta),
        hasPendingDelta: Boolean(entry?.hasPendingDelta),
        includedAdded: Number(entry?.stats?.includedAdded ?? 0),
        includedRemoved: Number(entry?.stats?.includedRemoved ?? 0),
        pendingAdded: Number(entry?.stats?.pendingAdded ?? 0),
        pendingRemoved: Number(entry?.stats?.pendingRemoved ?? 0),
    };
}

export function fileHasDeltaForArea(file: ScmFileStatus, delta: ScmEntryDelta | null, area: ScmDiffArea): boolean {
    if (delta) {
        if (area === 'included') return delta.hasIncludedDelta;
        if (area === 'pending') return delta.hasPendingDelta;
        return delta.hasIncludedDelta || delta.hasPendingDelta;
    }
    // Fallback when snapshot entries are not available in tests or partial snapshots.
    if (area === 'included') return file.isIncluded === true;
    if (area === 'pending') return file.isIncluded !== true;
    return true;
}

export function toAreaFileStatus(file: ScmFileStatus, delta: ScmEntryDelta | null, area: ScmDiffArea): ScmFileStatus {
    if (!delta) {
        // Best-effort: keep existing stats if we don't have entry-level numbers.
        return area === 'included'
            ? { ...file, isIncluded: true }
            : area === 'pending'
                ? { ...file, isIncluded: false }
                : file;
    }
    if (area === 'included') {
        return { ...file, isIncluded: true, linesAdded: delta.includedAdded, linesRemoved: delta.includedRemoved };
    }
    if (area === 'pending') {
        return { ...file, isIncluded: false, linesAdded: delta.pendingAdded, linesRemoved: delta.pendingRemoved };
    }
    return {
        ...file,
        linesAdded: delta.includedAdded + delta.pendingAdded,
        linesRemoved: delta.includedRemoved + delta.pendingRemoved,
    };
}
