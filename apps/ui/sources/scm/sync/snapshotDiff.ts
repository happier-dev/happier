import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

type SnapshotEntryComparable = {
    path: string;
    previousPath: string | null;
    includeStatus: string;
    pendingStatus: string;
    hasIncludedDelta: boolean;
    hasPendingDelta: boolean;
    stats: {
        includedAdded: number;
        includedRemoved: number;
        pendingAdded: number;
        pendingRemoved: number;
        isBinary: boolean;
    };
};

function toComparableMap(snapshot: ScmWorkingSnapshot | null | undefined): Map<string, SnapshotEntryComparable> {
    const map = new Map<string, SnapshotEntryComparable>();
    if (!snapshot) return map;
    for (const entry of snapshot.entries) {
        map.set(entry.path, {
            path: entry.path,
            previousPath: entry.previousPath,
            includeStatus: entry.includeStatus,
            pendingStatus: entry.pendingStatus,
            hasIncludedDelta: entry.hasIncludedDelta,
            hasPendingDelta: entry.hasPendingDelta,
            stats: {
                includedAdded: entry.stats.includedAdded,
                includedRemoved: entry.stats.includedRemoved,
                pendingAdded: entry.stats.pendingAdded,
                pendingRemoved: entry.stats.pendingRemoved,
                isBinary: entry.stats.isBinary,
            },
        });
    }
    return map;
}

function isEntryEqual(a: SnapshotEntryComparable | undefined, b: SnapshotEntryComparable | undefined): boolean {
    if (!a || !b) return false;
    return (
        a.previousPath === b.previousPath &&
        a.includeStatus === b.includeStatus &&
        a.pendingStatus === b.pendingStatus &&
        a.hasIncludedDelta === b.hasIncludedDelta &&
        a.hasPendingDelta === b.hasPendingDelta &&
        a.stats.includedAdded === b.stats.includedAdded &&
        a.stats.includedRemoved === b.stats.includedRemoved &&
        a.stats.pendingAdded === b.stats.pendingAdded &&
        a.stats.pendingRemoved === b.stats.pendingRemoved &&
        a.stats.isBinary === b.stats.isBinary
    );
}

export function collectChangedPaths(previous: ScmWorkingSnapshot | null | undefined, next: ScmWorkingSnapshot): string[] {
    const previousMap = toComparableMap(previous);
    const nextMap = toComparableMap(next);
    const candidatePaths = new Set<string>([
        ...Array.from(previousMap.keys()),
        ...Array.from(nextMap.keys()),
    ]);

    const changed: string[] = [];
    for (const path of candidatePaths) {
        const before = previousMap.get(path);
        const after = nextMap.get(path);
        if (!before || !after || !isEntryEqual(before, after)) {
            changed.push(path);
        }
    }
    return changed;
}
