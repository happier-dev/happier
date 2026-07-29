import type { BrowserStoragePartitionV1 } from '@happier-dev/protocol';

export type BrowserStoragePartitionsState = Readonly<{
    partitionsById: Readonly<Record<string, BrowserStoragePartitionV1>>;
}>;

export function createBrowserStoragePartitionsState(): BrowserStoragePartitionsState {
    return { partitionsById: {} };
}

export function upsertBrowserStoragePartition(
    state: BrowserStoragePartitionsState,
    partition: BrowserStoragePartitionV1,
): BrowserStoragePartitionsState {
    return {
        partitionsById: {
            ...state.partitionsById,
            [partition.partitionId]: partition,
        },
    };
}

export function selectBrowserStoragePartitionForOrigin(
    state: BrowserStoragePartitionsState,
    input: Readonly<{ profileId: string; originKey: string }>,
): BrowserStoragePartitionV1 | null {
    for (const partition of Object.values(state.partitionsById)) {
        if (partition.profileId === input.profileId && partition.originKey === input.originKey) {
            return (partition.state ?? 'active') === 'active' ? partition : null;
        }
    }
    return null;
}

export function dropBrowserStoragePartitionsForProfiles(
    state: BrowserStoragePartitionsState,
    profileIds: ReadonlySet<string>,
): BrowserStoragePartitionsState {
    const partitionsById: Record<string, BrowserStoragePartitionV1> = {};
    for (const partition of Object.values(state.partitionsById)) {
        if (profileIds.has(partition.profileId)) continue;
        partitionsById[partition.partitionId] = partition;
    }
    return { partitionsById };
}
