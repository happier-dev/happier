import type { ScmDiffArea } from '@happier-dev/protocol/scm/workingSnapshot';

import type { ScmWorkingEntry, ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export function totalsChangedLines(snapshot: ScmWorkingSnapshot | null, area: ScmDiffArea): number {
    const totals = snapshot?.totals;
    if (!totals) return 0;
    if (area === 'included') return totals.includedAdded + totals.includedRemoved;
    if (area === 'pending') return totals.pendingAdded + totals.pendingRemoved;
    return totals.includedAdded + totals.includedRemoved + totals.pendingAdded + totals.pendingRemoved;
}

export function indexScmEntriesByPath(entries: readonly ScmWorkingEntry[]): ReadonlyMap<string, ScmWorkingEntry> {
    const map = new Map<string, ScmWorkingEntry>();
    for (const entry of entries) {
        if (!entry.path) continue;
        map.set(entry.path, entry);
    }
    return map;
}

export function fileHasDeltaForArea(file: ScmFileStatus, delta: ScmWorkingEntry | null, area: ScmDiffArea): boolean {
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

export function toAreaFileStatus(file: ScmFileStatus, delta: ScmWorkingEntry | null, area: ScmDiffArea): ScmFileStatus {
    if (!delta) {
        // Best-effort: keep existing stats if we don't have entry-level numbers.
        const isIncluded = area === 'both' ? file.isIncluded : area === 'included';
        return file.isIncluded === isIncluded ? file : { ...file, isIncluded };
    }
    const isIncluded = area === 'both' ? file.isIncluded : area === 'included';
    const linesAdded = area === 'included' ? delta.stats.includedAdded : area === 'pending'
        ? delta.stats.pendingAdded : delta.stats.includedAdded + delta.stats.pendingAdded;
    const linesRemoved = area === 'included' ? delta.stats.includedRemoved : area === 'pending'
        ? delta.stats.pendingRemoved : delta.stats.includedRemoved + delta.stats.pendingRemoved;
    // Status rows already carry their area's facts. Keep those rows rather than copying the
    // entire checkout again before Review can draw its first visible diff.
    if (file.isIncluded === isIncluded && file.linesAdded === linesAdded && file.linesRemoved === linesRemoved
        && file.hasIncludedDelta === delta.hasIncludedDelta && file.isComplete === delta.stats.isComplete) return file;
    return {
        ...file,
        isIncluded,
        hasIncludedDelta: delta.hasIncludedDelta,
        isComplete: delta.stats.isComplete,
        linesAdded,
        linesRemoved,
    };
}
