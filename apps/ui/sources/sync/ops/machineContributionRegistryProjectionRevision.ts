/**
 * The one currentness revision for a machine's contribution-registry
 * projection.
 *
 * It lives apart from the RPC owner only because the canonical machine-state
 * writer must be able to advance it: a replaced or restarted daemon is a
 * different endpoint, and every projection consumer already subscribes here.
 * The RPC module re-exports these functions, so there is still exactly one
 * revision map, one listener set, and one decision about what "current" means.
 */
export type MachineContributionRegistryProjectionScope = Readonly<{
    machineId: string;
    serverId: string | null;
}>;

const projectionRevisionByScope = new Map<string, number>();
const projectionListenersByScope = new Map<string, Set<() => void>>();

export function machineContributionRegistryProjectionScopeKey(
    scope: MachineContributionRegistryProjectionScope,
): string {
    return JSON.stringify([scope.serverId, scope.machineId]);
}

export function getMachineContributionRegistryProjectionRevision(
    scope: MachineContributionRegistryProjectionScope,
): number {
    return projectionRevisionByScope.get(machineContributionRegistryProjectionScopeKey(scope)) ?? 0;
}

export function subscribeMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
    listener: () => void,
): () => void {
    const key = machineContributionRegistryProjectionScopeKey(scope);
    const listeners = projectionListenersByScope.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    projectionListenersByScope.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) projectionListenersByScope.delete(key);
    };
}

export function publishMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
): void {
    const key = machineContributionRegistryProjectionScopeKey(scope);
    projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
    for (const listener of projectionListenersByScope.get(key) ?? []) listener();
}

export function publishMachineContributionRegistryProjectionReconnect(): void {
    for (const key of [...projectionListenersByScope.keys()]) {
        projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
        for (const listener of projectionListenersByScope.get(key) ?? []) listener();
    }
}
