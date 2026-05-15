import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

type SnapshotEntryComparable = {
    path: string;
    previousPath: string | null;
    kind: string;
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
            kind: entry.kind,
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
        a.kind === b.kind &&
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

function areJsonComparableValuesEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function areSnapshotEntriesEqual(a: ScmWorkingSnapshot, b: ScmWorkingSnapshot): boolean {
    if (a.entries.length !== b.entries.length) return false;
    const aMap = toComparableMap(a);
    const bMap = toComparableMap(b);
    for (const [path, entry] of aMap.entries()) {
        if (!isEntryEqual(entry, bMap.get(path))) return false;
    }
    return true;
}

export function areScmWorkingSnapshotsEquivalentIgnoringFetchedAt(
    a: ScmWorkingSnapshot | null | undefined,
    b: ScmWorkingSnapshot | null | undefined,
): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.projectKey !== b.projectKey) return false;
    if (a.hasConflicts !== b.hasConflicts) return false;
    if (a.stashCount !== b.stashCount) return false;
    if (!areJsonComparableValuesEqual(a.repo, b.repo)) return false;
    if (!areJsonComparableValuesEqual(a.capabilities, b.capabilities)) return false;
    if (!areJsonComparableValuesEqual(a.branch, b.branch)) return false;
    if (!areJsonComparableValuesEqual(a.operationState, b.operationState)) return false;
    if (!areJsonComparableValuesEqual(a.hostingProvider, b.hostingProvider)) return false;
    if (!areJsonComparableValuesEqual(a.pullRequestStatus, b.pullRequestStatus)) return false;
    if (!areJsonComparableValuesEqual(a.totals, b.totals)) return false;
    return areSnapshotEntriesEqual(a, b);
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
