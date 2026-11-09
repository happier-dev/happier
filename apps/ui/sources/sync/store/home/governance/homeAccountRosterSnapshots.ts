import type { HomeAccountListResultV1, HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';

import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';

export type HomeAccountRosterStatus = 'loading' | 'loading_more' | 'ready' | 'error';
export type HomeAccountRosterSnapshot = Readonly<{
    scope: ServerAccountScope;
    rows: readonly HomeAccountRowV1[];
    total: number | null;
    status: HomeAccountRosterStatus;
    error: HomeActionFailure | null;
    cursor: string | null;
    hasMore: boolean;
    stale: boolean;
    /** A credential mutation withdraws display data, including an older pending answer. */
    retired: boolean;
}>;

const NO_ROWS: readonly HomeAccountRowV1[] = Object.freeze([]);
const snapshots = new Map<string, HomeAccountRosterSnapshot>();
const listeners = new Map<string, Set<() => void>>();

export function getHomeAccountRosterSnapshot(scope: ServerAccountScope | null): HomeAccountRosterSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}

function write(scope: ServerAccountScope, snapshot: HomeAccountRosterSnapshot): void {
    const key = serverAccountScopeKeySuffix(scope);
    snapshots.set(key, Object.freeze(snapshot));
    for (const listener of [...listeners.get(key) ?? []]) listener();
}

export function subscribeHomeAccountRosterSnapshot(scope: ServerAccountScope | null, listener: () => void): () => void {
    if (!scope) return () => {};
    const key = serverAccountScopeKeySuffix(scope);
    const scoped = listeners.get(key) ?? new Set<() => void>();
    listeners.set(key, scoped);
    scoped.add(listener);
    return () => {
        scoped.delete(listener);
        if (scoped.size === 0) listeners.delete(key);
    };
}

export function beginHomeAccountRosterLoad(scope: ServerAccountScope, more: boolean): void {
    const previous = getHomeAccountRosterSnapshot(scope);
    write(scope, {
        scope,
        rows: previous?.rows ?? NO_ROWS,
        total: previous?.total ?? null,
        cursor: previous?.cursor ?? null,
        hasMore: previous?.hasMore ?? true,
        stale: previous?.stale ?? false,
        retired: false,
        status: more ? 'loading_more' : 'loading',
        error: null,
    });
}

export function applyHomeAccountRosterPage(scope: ServerAccountScope, page: HomeAccountListResultV1, more: boolean, current: boolean): void {
    const previous = getHomeAccountRosterSnapshot(scope);
    if (previous?.retired) return;
    const incoming = more ? [...previous?.rows ?? [], ...page.items] : page.items;
    write(scope, {
        scope,
        rows: retainKeyedRows(previous?.rows ?? null, incoming, row => row.accountId),
        total: page.total ?? null,
        status: 'ready',
        error: null,
        cursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
        stale: !current,
        retired: false,
    });
}

export function applyHomeAccountRosterFailure(scope: ServerAccountScope, error: HomeActionFailure): void {
    const previous = getHomeAccountRosterSnapshot(scope);
    if (previous?.retired) return;
    const withdrawn = isAuthoritativeScopedSnapshotRefusalKind(error.kind);
    write(scope, {
        scope,
        rows: withdrawn ? NO_ROWS : previous?.rows ?? NO_ROWS,
        total: withdrawn ? null : previous?.total ?? null,
        cursor: withdrawn ? null : previous?.cursor ?? null,
        hasMore: !withdrawn && (previous?.hasMore ?? true),
        status: 'error',
        error,
        stale: previous?.stale ?? false,
        retired: false,
    });
}

export function invalidateHomeAccountRosterSnapshot(scope: ServerAccountScope): void {
    const current = getHomeAccountRosterSnapshot(scope);
    // Only the engine consumes this fact. Subscribers observe the read's loading/result state.
    if (current && !current.stale) snapshots.set(serverAccountScopeKeySuffix(scope), Object.freeze({ ...current, stale: true }));
}

export function invalidateHomeAccountRosterSnapshotsForServer(serverId: string): void {
    for (const snapshot of snapshots.values()) {
        if (areServerProfileIdentifiersEquivalent(snapshot.scope.serverId, serverId)) invalidateHomeAccountRosterSnapshot(snapshot.scope);
    }
}

export function retireHomeAccountRosterSnapshot(scope: ServerAccountScope): void {
    write(scope, { scope, rows: NO_ROWS, total: null, cursor: null, hasMore: false,
        status: 'error', error: { kind: 'unauthorized', retryable: false, code: null }, stale: true, retired: true });
}

export function resetHomeAccountRosterSnapshotsForTests(): void {
    snapshots.clear();
    listeners.clear();
}
