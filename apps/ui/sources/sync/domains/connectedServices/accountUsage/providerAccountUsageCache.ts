import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveProviderAccountUsageSnapshotState } from './providerAccountUsageSelectors';

export type ProviderAccountUsageCacheEntry = Readonly<{
    snapshot: ProviderAccountUsageSnapshotV1 | null;
    nextFetchAtMs: number;
    loading: boolean;
    hadError: boolean;
}>;

export type ProviderAccountUsageCacheState = Readonly<{
    entriesByCredentialScope: Record<string, Record<string, ProviderAccountUsageCacheEntry>>;
}>;

let providerAccountUsageCacheState: ProviderAccountUsageCacheState = {
    entriesByCredentialScope: {},
};
// Equal data can age into a different presentation at the existing observer's deadline.
let publishedAtMs = Date.now();

const providerAccountUsageCacheListeners = new Set<() => void>();
type RetainedUsageEntry = { count: number; observerCount: number; disposeObservation: (() => void) | null };
const providerAccountUsageCacheRetainCounts = new Map<string, Map<string, RetainedUsageEntry>>();

function publishProviderAccountUsageCacheState(next: ProviderAccountUsageCacheState): void {
    providerAccountUsageCacheState = next;
    publishedAtMs = Date.now();
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
 * Retains acquisition only for the exact usage rows demanded by a mounted surface.
 * Last-known-good rows survive observation gaps in this Account scope, so reopening
 * can display them while the new observation revalidates. A scope replacement
 * drops the previous Account's rows at the existing publication boundary.
 */
export function retainProviderAccountUsageCacheEntries(
    credentialScope: string,
    recordIds: ReadonlyArray<string>,
    observe?: (recordId: string) => () => void,
): () => void {
    if (!credentialScope || recordIds.length === 0) return () => {};
    const uniqueRecordIds = [...new Set(recordIds)];
    const counts = providerAccountUsageCacheRetainCounts.get(credentialScope)
        ?? new Map<string, RetainedUsageEntry>();
    providerAccountUsageCacheRetainCounts.set(credentialScope, counts);
    for (const recordId of uniqueRecordIds) {
        const retained = counts.get(recordId) ?? { count: 0, observerCount: 0, disposeObservation: null };
        retained.count += 1;
        if (observe) {
            retained.observerCount += 1;
            if (!retained.disposeObservation) retained.disposeObservation = observe(recordId);
        }
        counts.set(recordId, retained);
    }

    let released = false;
    return () => {
        if (released) return;
        released = true;
        for (const recordId of uniqueRecordIds) {
            const retained = counts.get(recordId);
            if (!retained) continue;
            retained.count -= 1;
            if (observe) retained.observerCount -= 1;
            if (retained.observerCount === 0) {
                retained.disposeObservation?.();
                retained.disposeObservation = null;
                // Facts survive the last observer, its cancelled activity does not.
                // Only touch a scope still present: an old release cannot republish
                // a superseded Account after a replacement scope has arrived.
                const current = providerAccountUsageCacheState.entriesByCredentialScope[credentialScope]?.[recordId];
                if (current?.loading) updateProviderAccountUsageCacheEntries(credentialScope, entries => ({
                    ...entries, [recordId]: { ...current, loading: false },
                }));
            }
            if (retained.count === 0) counts.delete(recordId);
        }
        if (counts.size === 0) providerAccountUsageCacheRetainCounts.delete(credentialScope);

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
    const incomingEntries = retained && retained.size > 0
        ? Object.fromEntries(
            Object.entries(updatedEntries).filter(([recordId]) => retained.has(recordId) || recordId in currentEntries),
        )
        : updatedEntries;
    const nowMs = Date.now();
    const nextEntries: Record<string, ProviderAccountUsageCacheEntry> = {};
    let unchanged = Object.keys(currentEntries).length === Object.keys(incomingEntries).length;
    for (const [recordId, incoming] of Object.entries(incomingEntries)) {
        const previous = currentEntries[recordId];
        const next = previous && incoming.snapshot !== previous.snapshot
            && sameStrictJsonValue(previous.snapshot, incoming.snapshot)
            ? { ...incoming, snapshot: previous.snapshot }
            : incoming;
        const equal = previous && previous.snapshot === next.snapshot && sameStrictJsonValue(previous, next)
            && resolveProviderAccountUsageSnapshotState({ ...previous, nowMs: publishedAtMs })
                === resolveProviderAccountUsageSnapshotState({ ...next, nowMs });
        nextEntries[recordId] = equal ? previous : next === previous ? { ...next } : next;
        if (nextEntries[recordId] !== previous) unchanged = false;
    }
    const scopes = Object.keys(providerAccountUsageCacheState.entriesByCredentialScope);
    if (unchanged && (scopes.length === 0 && Object.keys(nextEntries).length === 0
        || scopes.length === 1 && scopes[0] === credentialScope)) return;
    publishProviderAccountUsageCacheState({
        entriesByCredentialScope: { [credentialScope]: nextEntries },
    });
}
