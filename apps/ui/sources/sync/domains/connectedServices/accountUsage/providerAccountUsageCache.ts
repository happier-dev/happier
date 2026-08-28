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
const providerAccountUsageCacheRetainCounts = new Map<string, Map<string, number>>();

function publishProviderAccountUsageCacheState(next: ProviderAccountUsageCacheState): void {
    providerAccountUsageCacheState = next;
    for (const listener of providerAccountUsageCacheListeners) listener();
}

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
 * Retains the exact usage rows required by a mounted surface. The cache is a
 * last-known-good presentation owner, not a session-history archive, so the
 * final release removes rows that no live consumer can render.
 */
export function retainProviderAccountUsageCacheEntries(
    credentialScope: string,
    recordIds: ReadonlyArray<string>,
): () => void {
    if (!credentialScope || recordIds.length === 0) return () => {};
    const uniqueRecordIds = [...new Set(recordIds)];
    const counts = providerAccountUsageCacheRetainCounts.get(credentialScope)
        ?? new Map<string, number>();
    providerAccountUsageCacheRetainCounts.set(credentialScope, counts);
    for (const recordId of uniqueRecordIds) {
        counts.set(recordId, (counts.get(recordId) ?? 0) + 1);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        for (const recordId of uniqueRecordIds) {
            const nextCount = (counts.get(recordId) ?? 0) - 1;
            if (nextCount > 0) counts.set(recordId, nextCount);
            else counts.delete(recordId);
        }
        if (counts.size === 0) providerAccountUsageCacheRetainCounts.delete(credentialScope);

        const currentEntries = providerAccountUsageCacheState
            .entriesByCredentialScope[credentialScope];
        if (!currentEntries) return;
        const nextEntries = Object.fromEntries(
            Object.entries(currentEntries).filter(([recordId]) => counts.has(recordId)),
        );
        if (Object.keys(nextEntries).length === Object.keys(currentEntries).length) return;
        publishProviderAccountUsageCacheState({
            entriesByCredentialScope: Object.keys(nextEntries).length === 0
                ? {}
                : { [credentialScope]: nextEntries },
        });
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
    const updatedEntries = updater(currentEntries);
    const retained = providerAccountUsageCacheRetainCounts.get(credentialScope);
    const nextEntries = retained && retained.size > 0
        ? Object.fromEntries(
            Object.entries(updatedEntries).filter(([recordId]) => retained.has(recordId)),
        )
        : updatedEntries;
    publishProviderAccountUsageCacheState({
        entriesByCredentialScope: { [credentialScope]: nextEntries },
    });
}
