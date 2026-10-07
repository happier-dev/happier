import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type AppliedActiveServerSnapshot = Readonly<Pick<
    ReturnType<typeof getActiveServerSnapshot>,
    'serverId' | 'serverUrl' | 'generation'
>>;

function captureAppliedActiveServerSnapshot(snapshot: AppliedActiveServerSnapshot): AppliedActiveServerSnapshot {
    return {
        serverId: String(snapshot.serverId ?? '').trim(),
        serverUrl: String(snapshot.serverUrl ?? '').trim(),
        generation: snapshot.generation,
    };
}

// The last applied Home and whether its runtime still serves it are separate facts.
let appliedActiveServerSnapshot: AppliedActiveServerSnapshot | null = null;
let appliedActiveServerRuntimeAvailable = false;
const appliedActiveServerListeners = new Set<(serverId: string, generation: number) => void>();
const appliedActiveServerRuntimeAvailabilityListeners = new Set<(available: boolean) => void>();
const applyingActiveServerListeners = new Set<(serverId: string, generation: number) => void>();

export function getAppliedActiveServerSnapshot(): AppliedActiveServerSnapshot {
    // Read lazily: persisted Home selection may not be restored at module load.
    appliedActiveServerSnapshot ??= captureAppliedActiveServerSnapshot(getActiveServerSnapshot());
    return appliedActiveServerSnapshot;
}

export function getAppliedActiveServerId(): string {
    return getAppliedActiveServerSnapshot().serverId;
}

export function isAppliedActiveServerRuntimeAvailable(): boolean {
    return appliedActiveServerRuntimeAvailable;
}

export function publishAppliedActiveServerRuntimeAvailability(runtimeAvailable: boolean): boolean {
    if (appliedActiveServerRuntimeAvailable === runtimeAvailable) return false;
    appliedActiveServerRuntimeAvailable = runtimeAvailable;
    // Account cancellation belongs to the producer transition, before a UI
    // subscriber can discover the stale lifetime while rendering.
    if (!runtimeAvailable) retireActiveServerAccountScopeLifetime();
    for (const listener of appliedActiveServerRuntimeAvailabilityListeners) listener(runtimeAvailable);
    return true;
}

export function publishApplyingActiveServerId(serverIdRaw: string, generation: number): void {
    publishAppliedActiveServerRuntimeAvailability(false);
    const serverId = String(serverIdRaw ?? '').trim();
    for (const listener of applyingActiveServerListeners) listener(serverId, generation);
}

/**
 * The connection owner publishes unavailable before restoring or switching,
 * then publishes this completed snapshot. Account retirement belongs to that
 * earlier boundary, before Sync setup and any subscriber render can run.
 */
export function publishAppliedActiveServerSnapshot(snapshot: AppliedActiveServerSnapshot, runtimeAvailable = true): void {
    const next = captureAppliedActiveServerSnapshot(snapshot);
    publishAppliedActiveServerRuntimeAvailability(runtimeAvailable);
    const current = appliedActiveServerSnapshot;
    const didChangeSnapshot = current === null || !(
        next.serverId === current.serverId
        && next.serverUrl === current.serverUrl
        && next.generation === current.generation
    );
    if (!didChangeSnapshot) return;
    appliedActiveServerSnapshot = next;
    for (const listener of appliedActiveServerListeners) listener(next.serverId, next.generation);
}

export function subscribeAppliedActiveServer(listener: (serverId: string, generation: number) => void): () => void {
    appliedActiveServerListeners.add(listener);
    return () => { appliedActiveServerListeners.delete(listener); };
}

export function subscribeAppliedActiveServerRuntimeAvailability(listener: (available: boolean) => void): () => void {
    appliedActiveServerRuntimeAvailabilityListeners.add(listener);
    return () => { appliedActiveServerRuntimeAvailabilityListeners.delete(listener); };
}

export function subscribeApplyingActiveServer(listener: (serverId: string, generation: number) => void): () => void {
    applyingActiveServerListeners.add(listener);
    return () => { applyingActiveServerListeners.delete(listener); };
}
