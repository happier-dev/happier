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

/**
 * Commits usage entries for the credential scope that is currently active, and
 * drops every superseded scope.
 *
 * The only writer (`useProviderAccountUsageSnapshots`) refuses to commit under
 * a scope that is no longer active, so a write identifies the live scope. Once
 * a re-login, server switch, or generation bump supersedes a scope, its keys
 * can never be read again — the sibling quota stores release such entries at
 * their retain boundary, and keeping them here instead leaked one whole scope
 * of snapshots per switch for the lifetime of the session.
 *
 * Entries already cached under the active scope are preserved: the updater
 * receives them so a refresh never blanks last-known-good usage.
 */
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
        entriesByCredentialScope: { [credentialScope]: nextEntries },
    };
    for (const listener of providerAccountUsageCacheListeners) listener();
}
