import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';

export type ProviderAccountUsageCacheEntry = Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    nextFetchAtMs: number;
    consecutiveErrors: number;
    loading: boolean;
    hadError: boolean;
}>;

export type ProviderAccountUsageCacheState = Readonly<{
    entriesByCredentialScope: Record<string, Record<string, ProviderAccountUsageCacheEntry>>;
}>;

let providerAccountUsageCacheState: ProviderAccountUsageCacheState = {
    entriesByCredentialScope: {},
};

const providerAccountUsageCacheListeners = new Set<() => void>();

export function getProviderAccountUsageCacheState(): ProviderAccountUsageCacheState {
    return providerAccountUsageCacheState;
}

export function subscribeProviderAccountUsageCache(listener: () => void): () => void {
    providerAccountUsageCacheListeners.add(listener);
    return () => {
        providerAccountUsageCacheListeners.delete(listener);
    };
}

export function updateProviderAccountUsageCacheEntries(
    credentialScope: string,
    updater: (
        entries: Record<string, ProviderAccountUsageCacheEntry>,
    ) => Record<string, ProviderAccountUsageCacheEntry>,
): void {
    if (!credentialScope) return;
    const currentEntries = providerAccountUsageCacheState.entriesByCredentialScope[credentialScope] ?? {};
    const nextEntries = updater(currentEntries);
    providerAccountUsageCacheState = {
        entriesByCredentialScope: {
            ...providerAccountUsageCacheState.entriesByCredentialScope,
            [credentialScope]: nextEntries,
        },
    };
    for (const listener of providerAccountUsageCacheListeners) listener();
}
