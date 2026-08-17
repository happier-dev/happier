export type PoolMembershipDiff = Readonly<{
    toAdd: ReadonlyArray<string>;
    toRemove: ReadonlyArray<string>;
}>;

/**
 * Resolves the exact membership change needed to realize `nextSelectedIds`:
 * ids selected but not currently members are added, current members no longer
 * selected are removed. Order-insensitive and duplicate-safe (Set-backed).
 */
export function computePoolMembershipDiff(
    currentMemberIds: ReadonlyArray<string>,
    nextSelectedIds: ReadonlyArray<string>,
): PoolMembershipDiff {
    const current = new Set(currentMemberIds);
    const next = new Set(nextSelectedIds);
    return {
        toAdd: [...next].filter((id) => !current.has(id)),
        toRemove: [...current].filter((id) => !next.has(id)),
    };
}
