import type { HomeSessionDefaultsProjectionV1 } from '@happier-dev/protocol/home/governance/projection';
import { isAuthoritativeScopedSnapshotRefusal, type ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { retainDeep, retainShallow } from '@/sync/domains/state/structuralSharing';

/** Member-readable defaults are separate from the administrator-only governance projection. */
export type HomeSessionDefaultsSnapshot = Readonly<{
    scope: ServerAccountScope;
    data: HomeSessionDefaultsProjectionV1 | null;
    error: ScopedSnapshotError | null;
    stale: boolean;
}>;

const snapshots = new Map<string, HomeSessionDefaultsSnapshot>();
const listeners = new Set<() => void>();

export function getHomeSessionDefaultsSnapshot(scope: ServerAccountScope | null | undefined): HomeSessionDefaultsSnapshot | null {
    return scope ? snapshots.get(serverAccountScopeKeySuffix(scope)) ?? null : null;
}

export function subscribeHomeSessionDefaultsSnapshots(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

function write(scope: ServerAccountScope, next: Omit<HomeSessionDefaultsSnapshot, 'scope'>): void {
    const key = serverAccountScopeKeySuffix(scope);
    const previous = snapshots.get(key);
    const retained = retainShallow(previous, { scope: previous?.scope ?? scope, ...next });
    if (retained === previous) return;
    snapshots.set(key, retained);
    for (const listener of [...listeners]) listener();
}

export function applyHomeSessionDefaultsProjection(scope: ServerAccountScope, data: HomeSessionDefaultsProjectionV1, current: boolean): void {
    write(scope, { data: retainDeep(getHomeSessionDefaultsSnapshot(scope)?.data ?? undefined, data), error: null, stale: !current });
}

export function applyHomeSessionDefaultsFailure(scope: ServerAccountScope, error: ScopedSnapshotError): void {
    const data = isAuthoritativeScopedSnapshotRefusal(error) ? null : getHomeSessionDefaultsSnapshot(scope)?.data ?? null;
    write(scope, { data, error: retainShallow(getHomeSessionDefaultsSnapshot(scope)?.error ?? undefined, error), stale: data !== null });
}

export function invalidateHomeSessionDefaultsSnapshot(scope: ServerAccountScope): void {
    const current = getHomeSessionDefaultsSnapshot(scope);
    if (current && !current.stale) write(scope, { ...current, stale: true });
}

export function invalidateHomeSessionDefaultsSnapshotsForServer(serverId: string): void {
    let changed = false;
    for (const [key, current] of snapshots) {
        if (current.scope.serverId !== serverId || current.stale) continue;
        snapshots.set(key, { ...current, stale: true });
        changed = true;
    }
    if (changed) for (const listener of [...listeners]) listener();
}

export function retireHomeSessionDefaultsSnapshot(scope: ServerAccountScope): void {
    if (snapshots.delete(serverAccountScopeKeySuffix(scope))) {
        for (const listener of [...listeners]) listener();
    }
}

export function resetHomeSessionDefaultsSnapshotsForTests(): void {
    snapshots.clear();
    listeners.clear();
}
