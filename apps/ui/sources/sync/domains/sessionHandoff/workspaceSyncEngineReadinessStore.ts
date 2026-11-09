import type { WorkspaceSyncRuntimeReadinessV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export type WorkspaceSyncEngineScope = Readonly<{
    serverId?: string | null;
    machineId: string;
}>;

export type WorkspaceSyncEngineReadinessSnapshot = Readonly<{
    phase: 'idle' | 'probing' | 'ready' | 'unavailable';
    errorCode: string | null;
    carrierPhase: 'unknown' | 'ready' | 'unavailable';
    carrierErrorCode: string | null;
}>;

type Entry = {
    snapshot: WorkspaceSyncEngineReadinessSnapshot;
    listeners: Set<() => void>;
};

const entries = new Map<string, Entry>();
const IDLE_SNAPSHOT: WorkspaceSyncEngineReadinessSnapshot = {
    phase: 'idle', errorCode: null, carrierPhase: 'unknown', carrierErrorCode: null,
};

function keyFor(scope: WorkspaceSyncEngineScope): string {
    return JSON.stringify([scope.serverId ?? null, scope.machineId]);
}

function entryFor(scope: WorkspaceSyncEngineScope): Entry {
    const key = keyFor(scope);
    const existing = entries.get(key);
    if (existing) return existing;
    const entry: Entry = { snapshot: IDLE_SNAPSHOT, listeners: new Set() };
    entries.set(key, entry);
    return entry;
}

function publish(entry: Entry, snapshot: WorkspaceSyncEngineReadinessSnapshot): void {
    const previous = entry.snapshot;
    if (previous.phase === snapshot.phase
        && previous.errorCode === snapshot.errorCode
        && previous.carrierPhase === snapshot.carrierPhase
        && previous.carrierErrorCode === snapshot.carrierErrorCode) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
}

export function getWorkspaceSyncEngineReadinessSnapshot(
    scope: WorkspaceSyncEngineScope,
): WorkspaceSyncEngineReadinessSnapshot {
    return entryFor(scope).snapshot;
}

export function subscribeWorkspaceSyncEngineReadiness(
    scope: WorkspaceSyncEngineScope,
    listener: () => void,
): () => void {
    const entry = entryFor(scope);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
}

export function applyWorkspaceSyncEngineReadinessEvent(
    scope: WorkspaceSyncEngineScope,
    readiness: WorkspaceSyncRuntimeReadinessV1,
): void {
    const engine = readiness.engine.state === 'unavailable'
        ? { phase: 'unavailable' as const, errorCode: readiness.engine.errorCode }
        : readiness.engine.state === 'starting'
            ? { phase: 'probing' as const, errorCode: null }
            : { phase: 'ready' as const, errorCode: null };
    const carrier = readiness.carrier.state === 'unavailable'
        ? { carrierPhase: 'unavailable' as const, carrierErrorCode: readiness.carrier.errorCode }
        : { carrierPhase: 'ready' as const, carrierErrorCode: null };
    const snapshot: WorkspaceSyncEngineReadinessSnapshot = { ...engine, ...carrier };
    publish(entryFor(scope), snapshot);
}

export function resetWorkspaceSyncEngineReadinessStoreForTests(): void {
    entries.clear();
}
