import type { GitWorkingSnapshot } from '@/sync/storageTypes';

type SnapshotEntryComparable = {
    path: string;
    previousPath: string | null;
    indexStatus: string;
    worktreeStatus: string;
    hasStagedDelta: boolean;
    hasUnstagedDelta: boolean;
    stats: {
        stagedAdded: number;
        stagedRemoved: number;
        unstagedAdded: number;
        unstagedRemoved: number;
        isBinary: boolean;
    };
};

function toComparableMap(snapshot: GitWorkingSnapshot | null | undefined): Map<string, SnapshotEntryComparable> {
    const map = new Map<string, SnapshotEntryComparable>();
    if (!snapshot) return map;
    for (const entry of snapshot.entries) {
        map.set(entry.path, {
            path: entry.path,
            previousPath: entry.previousPath,
            indexStatus: entry.indexStatus,
            worktreeStatus: entry.worktreeStatus,
            hasStagedDelta: entry.hasStagedDelta,
            hasUnstagedDelta: entry.hasUnstagedDelta,
            stats: {
                stagedAdded: entry.stats.stagedAdded,
                stagedRemoved: entry.stats.stagedRemoved,
                unstagedAdded: entry.stats.unstagedAdded,
                unstagedRemoved: entry.stats.unstagedRemoved,
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
        a.indexStatus === b.indexStatus &&
        a.worktreeStatus === b.worktreeStatus &&
        a.hasStagedDelta === b.hasStagedDelta &&
        a.hasUnstagedDelta === b.hasUnstagedDelta &&
        a.stats.stagedAdded === b.stats.stagedAdded &&
        a.stats.stagedRemoved === b.stats.stagedRemoved &&
        a.stats.unstagedAdded === b.stats.unstagedAdded &&
        a.stats.unstagedRemoved === b.stats.unstagedRemoved &&
        a.stats.isBinary === b.stats.isBinary
    );
}

export function collectChangedPaths(previous: GitWorkingSnapshot | null | undefined, next: GitWorkingSnapshot): string[] {
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
