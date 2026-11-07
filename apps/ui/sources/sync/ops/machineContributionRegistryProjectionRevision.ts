import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerProfileScopeResolver, resolveServerProfileScopeIdForIdentifier, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';

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

/**
 * Why a Machine projection is asked again. `refresh` re-reads the same
 * authority (registry adoption, settings change, Retry): readers
 * keep their last-good projection current while it is in flight. `authority`
 * means the answering authority itself changed (daemon identity, occurrence
 * replacement, retirement): readers fail closed until the new answer. A real
 * transport loss already withdraws Machine presence, which demotes readers
 * without an invalidation.
 */
export type MachineContributionRegistryProjectionInvalidationReason = 'refresh' | 'authority';

const projectionRevisionByScope = new Map<string, number>();
const authorityRevisionByScope = new Map<string, number>();
const projectionListenersByScope = new Map<string, Set<() => void>>();

function readProjectionRevision(key: string): number {
    const revision = projectionRevisionByScope.get(key);
    if (revision !== undefined) return revision;
    // Direct readers retain answers after their surface unmounts. Keep their
    // existing revision slot so an explicit Home refresh includes those answers.
    projectionRevisionByScope.set(key, 0);
    return 0;
}

export function machineContributionRegistryProjectionScopeKey(
    scope: MachineContributionRegistryProjectionScope,
    resolveScopeId: ProfileScopeResolver = resolveServerProfileScopeIdForIdentifier,
): string {
    return JSON.stringify([
        resolveScopeId(scope.serverId ?? getActiveServerSnapshot().serverId),
        scope.machineId,
    ]);
}

export function getMachineContributionRegistryProjectionRevision(
    scope: MachineContributionRegistryProjectionScope,
): number {
    return readProjectionRevision(machineContributionRegistryProjectionScopeKey(scope));
}

/** Advances only on `authority` invalidations; projection currentness gates on it. */
export function getMachineContributionRegistryProjectionAuthorityRevision(
    scope: MachineContributionRegistryProjectionScope,
): number {
    return authorityRevisionByScope.get(machineContributionRegistryProjectionScopeKey(scope)) ?? 0;
}

export function subscribeMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
    listener: () => void,
): () => void {
    const key = machineContributionRegistryProjectionScopeKey(scope);
    return subscribeProjectionKey(key, listener);
}

function subscribeProjectionKey(key: string, listener: () => void): () => void {
    const listeners = projectionListenersByScope.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    projectionListenersByScope.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) projectionListenersByScope.delete(key);
    };
}

/** Descriptive key preparation only; every read still observes the live revision map. */
export function captureMachineContributionRegistryProjectionScope(
    scope: MachineContributionRegistryProjectionScope,
    resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver(),
) {
    const key = machineContributionRegistryProjectionScopeKey(scope, resolveScopeId);
    return {
        key,
        readRevision: () => readProjectionRevision(key),
        subscribe: (listener: () => void) => subscribeProjectionKey(key, listener),
    };
}

export function publishMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
    /** Required: an omitted reason once demoted every Machine on Retry. */
    reason: MachineContributionRegistryProjectionInvalidationReason,
): void {
    const key = machineContributionRegistryProjectionScopeKey(scope);
    projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
    if (reason === 'authority') authorityRevisionByScope.set(key, (authorityRevisionByScope.get(key) ?? 0) + 1);
    for (const listener of projectionListenersByScope.get(key) ?? []) listener();
}

/** Explicit Home-wide refresh, including directly read, unmounted scopes. */
export function publishMachineContributionRegistryProjectionRefresh(
    serverId: string | null = getActiveServerSnapshot().serverId,
): void {
    if (!serverId) return;
    const resolvedServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    for (const key of new Set([...projectionRevisionByScope.keys(), ...projectionListenersByScope.keys()])) {
        // Scope keys are produced only by machineContributionRegistryProjectionScopeKey.
        const [scopeServerId] = JSON.parse(key) as [string, string];
        if (scopeServerId !== resolvedServerId) continue;
        projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
        for (const listener of projectionListenersByScope.get(key) ?? []) listener();
    }
}
