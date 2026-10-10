import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { buildMachineAgentsDetectRequest } from '@happier-dev/protocol/capabilities';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, subscribeMachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import { loadDaemonMergedProjectionCacheEntry, readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getMachineContributionRegistryProjectionRevision, subscribeMachineContributionRegistryProjectionInvalidation } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { useDaemonMergedProjectionInputs, type DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { loadAccountProfile } from '@/sync/domains/state/accountProfilePersistence';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopedResourceKey, areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerFeaturesSnapshotForServerId } from '@/sync/domains/features/featureDecisionRuntime';
import { resolveConnectedAccountUiNegotiation } from '@/sync/domains/connectedServices/resolveConnectedAccountUiNegotiation';
import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveConnectedServiceRegistryEntryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { t } from '@/text';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { buildMachineAgentInventoryDescriptors } from './machineAgentCatalog';
import { createMachineAgentInventoryPersistence } from './machineAgentInventoryPersistence';
import { projectMachineAgentCapabilityObservation } from './machineAgentCapabilityObservation';
import { machineAgentInventoryStore, EMPTY_MACHINE_AGENTS, type MachineAgentsSnapshot } from './machineAgentInventoryStore';
import { projectMachineAgentConnectedServices } from './machineAgentConnectedServices';
import type { MachineAgent, MachineAgentConnectedService } from './machineAgentTypes';
import { ensureMachineAgentInstallJobs } from './installJobs/installJobStore';

export type { MachineAgentsSnapshot } from './machineAgentInventoryStore';
export type MachineAgentsTarget = Readonly<{ serverId?: string | null; machineId: string | null | undefined; agentId?: string; enabled?: boolean; load?: boolean }>;

// Retain the previous CLI-detection owner's five-minute auth-probe freshness budget.
const AUTH_PROBE_STALE_MS = 5 * 60_000;
const scopeKey = (lifetime: ServerAccountScopeLifetime, machineId: string) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents', machineId);
const capabilitySalt = (lifetime: ServerAccountScopeLifetime, revision: number) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents-capabilities', String(revision));

function useInventoryProjectionRevisions(serverId: string, machineIds: readonly string[]): string {
    const subscribe = React.useCallback((listener: () => void) => {
        const disposers = machineIds.map((machineId) => subscribeMachineContributionRegistryProjectionInvalidation({ serverId, machineId }, listener));
        return () => { for (const dispose of disposers) dispose(); };
    }, [machineIds, serverId]);
    const read = React.useCallback(() => JSON.stringify(machineIds.map((machineId) => getMachineContributionRegistryProjectionRevision({ serverId, machineId }))), [machineIds, serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

function hydrate(lifetime: ServerAccountScopeLifetime, machineId: string): void {
    if (!lifetime.isCurrent()) return;
    const key = scopeKey(lifetime, machineId);
    if (machineAgentInventoryStore.read(key) !== EMPTY_MACHINE_AGENTS) return;
    const saved = createMachineAgentInventoryPersistence(getPersistenceStorage()).read(lifetime.scope, machineId);
    if (saved) machineAgentInventoryStore.publish(key, { ...saved, status: 'offline' });
}

function observe(input: Readonly<{ lifetime: ServerAccountScopeLifetime; machineId: string; revision: number; projection: DaemonMergedProjectionInputsState; online: boolean; connectedServices?: Readonly<Record<string, readonly MachineAgentConnectedService[]>> }>): void {
    if (!input.lifetime.isCurrent()) return;
    const key = scopeKey(input.lifetime, input.machineId);
    const descriptors = input.projection.inputs ? buildMachineAgentInventoryDescriptors(input.projection.inputs) : undefined;
    const failed = input.projection.phase === 'error' || input.projection.phase === 'unsupported';
    const observation = input.online && descriptors && !failed
        ? projectMachineAgentCapabilityObservation(descriptors, getMachineCapabilitiesCacheState(input.machineId, input.lifetime.scope.serverId, capabilitySalt(input.lifetime, input.revision), input.lifetime.scope.accountId))
        : { status: !input.online ? 'offline' as const : failed ? 'error' as const : 'loading' as const, items: [], lastCheckedAt: null, ...(descriptors ? { descriptors } : {}) };
    const dependencyTitlesByKey = Object.fromEntries(getInstallablesRegistryEntries({ pluginProjection: input.projection.inputs?.pluginProjectionV2 ?? undefined }).map((entry) => [entry.key, entry.title]));
    machineAgentInventoryStore.publish(key, { ...observation, dependencyTitlesByKey, ...(input.connectedServices ? { connectedServicesByAgentId: input.connectedServices } : {}) });
    if (observation.status === 'ready' && observation.lastCheckedAt !== null) {
        createMachineAgentInventoryPersistence(getPersistenceStorage()).write(input.lifetime.scope, input.machineId, { items: [...observation.items], lastCheckedAt: observation.lastCheckedAt });
    }
}

/** Shared inventory/selected-Agent refresh; the credential lifetime, never focused Home, owns transport. */
export async function refreshMachineAgents(input: Readonly<{ serverId: string; machineId: string; accountLifetime: ServerAccountScopeLifetime; agentId?: string; force?: boolean }>): Promise<void> {
    const lifetime = input.accountLifetime;
    if (!lifetime.isCurrent() || lifetime.scope.serverId !== input.serverId) return;
    hydrate(lifetime, input.machineId);
    const machine = resolveServerScopedMachine(getStorage().getState(), input.serverId, input.machineId);
    const online = Boolean(machine && isMachineOnline(machine));
    const scope = { machineId: input.machineId, serverId: input.serverId };
    const revision = getMachineContributionRegistryProjectionRevision(scope);
    if (!online) { observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'idle', inputs: null }, online: false }); return; }
    const entry = await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime: lifetime });
    if (!lifetime.isCurrent()) return;
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    const inputs = entry?.kind === 'ready' || entry?.kind === 'error' ? entry.inputs ?? null : null;
    const agents = buildMachineAgentInventoryDescriptors(inputs);
    if (entry?.kind !== 'ready' || !inputs) {
        observe({ lifetime, machineId: input.machineId, revision, projection: { phase: entry?.kind === 'unsupported' ? 'unsupported' : 'error', inputs }, online });
        return;
    }
    if (agents.length === 0) {
        machineAgentInventoryStore.publish(scopeKey(lifetime, input.machineId), { status: 'ready', items: [], descriptors: [], lastCheckedAt: Date.now() });
        return;
    }
    const requestedAgents = input.agentId ? agents.filter((agent) => agent.agentId === input.agentId) : agents;
    if (requestedAgents.length === 0) return;
    const args = { machineId: input.machineId, serverId: input.serverId, accountLifetime: lifetime, cacheKeySalt: capabilitySalt(lifetime, revision), request: buildMachineAgentsDetectRequest({ agents: requestedAgents, refresh: input.force }) };
    await Promise.all([
        // Older daemons can still report inventory facts when install jobs are unavailable.
        ensureMachineAgentInstallJobs({ ...lifetime.scope, machineId: input.machineId }).catch(() => {}),
        input.force ? prefetchMachineCapabilities(args) : prefetchMachineCapabilitiesIfStale({ ...args, staleMs: AUTH_PROBE_STALE_MS }),
    ]);
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    const currentMachine = resolveServerScopedMachine(getStorage().getState(), input.serverId, input.machineId);
    observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs }, online: Boolean(currentMachine && isMachineOnline(currentMachine)) });
}

function useInventoryDriver(target: MachineAgentsTarget) {
    const activeServer = useActiveServerSnapshot(!target.serverId);
    const requestedServerId = target.serverId?.trim() || activeServer.serverId;
    const machineId = target.machineId?.trim() || '';
    const agentId = target.agentId?.trim() || undefined;
    const enabled = target.enabled !== false && Boolean(machineId && requestedServerId);
    const { binding } = useServerCredentialAccountScopeBinding(requestedServerId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const serverId = lifetime?.scope.serverId ?? requestedServerId;
    const key = enabled && lifetime ? scopeKey(lifetime, machineId) : null;
    const machine = getStorage()(useShallow((state) => {
        const row = enabled ? resolveServerScopedMachine(state, serverId, machineId) : null;
        return { online: Boolean(row && isMachineOnline(row)) };
    }));
    const machineIds = React.useMemo(() => enabled ? [machineId] : [], [enabled, machineId]);
    const projectionRevisions = useInventoryProjectionRevisions(serverId, machineIds);
    const revision = enabled ? getMachineContributionRegistryProjectionRevision({ serverId, machineId }) : 0;
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, enabled, load: enabled && machine.online && target.load !== false });
    const profileSlice = getStorage()(useShallow((state) => ({ scope: state.profileScope, connectedServicesV2: state.profile.connectedServicesV2, connectedAccountsV4: state.profile.connectedAccountsV4 })));
    const savedProfile = React.useMemo(() => lifetime ? loadAccountProfile(lifetime.scope) : profileDefaults, [lifetime]);
    const profile = lifetime && areServerAccountScopesEqual(profileSlice.scope, lifetime.scope) ? profileSlice : savedProfile;
    const registry = useProjectedConnectedServicesRegistry();
    const localize = useProjectedPluginLocalizedTextResolver();
    // Account authentication still needs Home negotiation when machine probes are passive.
    const features = useServerFeaturesSnapshotForServerId(serverId, { enabled });
    const connectedServices = React.useMemo(() => projectMachineAgentConnectedServices({
        agents: Object.entries(projection.inputs?.pluginProjectionV2?.agentsById ?? {}).map(([agentId, agent]) => ({ agentId, connectedAccounts: agent.connectedAccounts })),
        profile,
        accountTransport: resolveConnectedAccountUiNegotiation(features),
        // This registry belongs to the active Account. Another Home's metadata cannot authenticate this scope.
        entries: lifetime && areServerAccountScopesEqual(profileSlice.scope, lifetime.scope) ? registry.entries : [],
        now: Date.now(), titleForService: (entry) => resolveConnectedServiceRegistryEntryDisplayName(entry, t, localize),
    }), [features, lifetime, localize, profile, profileSlice.scope, projection.inputs, registry.entries]);
    React.useEffect(() => {
        if (!lifetime || !key) return;
        hydrate(lifetime, machineId);
        const publish = () => observe({ lifetime, machineId, revision, projection, online: machine.online, connectedServices });
        publish();
        const unsubscribe = subscribeMachineCapabilitiesCacheState(machineId, serverId, capabilitySalt(lifetime, revision), publish, lifetime.scope.accountId);
        return unsubscribe;
    }, [connectedServices, key, lifetime, machine.online, revision, machineId, projection.inputs, projection.phase, serverId]);
    React.useEffect(() => {
        if (!lifetime || !enabled || !machine.online || target.load === false) return;
        void refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId });
    }, [agentId, enabled, lifetime, machine.online, projectionRevisions, machineId, projection.inputs, serverId, target.load]);
    const refresh = React.useCallback(async () => {
        if (enabled && lifetime) await refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId, force: true });
    }, [agentId, enabled, lifetime, machineId, serverId]);
    return { key, lifetime, refresh };
}

export function useMachineAgents(target: MachineAgentsTarget): MachineAgentsSnapshot & Readonly<{ refresh(): Promise<void> }> {
    const { key, lifetime, refresh } = useInventoryDriver(target);
    const subscribe = React.useCallback((listener: () => void) => key ? machineAgentInventoryStore.subscribe(key, listener) : () => {}, [key]);
    const read = React.useCallback(() => key && lifetime?.isCurrent() ? machineAgentInventoryStore.read(key) : EMPTY_MACHINE_AGENTS, [key, lifetime]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    return React.useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot]);
}

export function useMachineAgent(target: MachineAgentsTarget & Readonly<{ agentId: string }>): MachineAgent | null {
    const { key, lifetime } = useInventoryDriver(target);
    const subscribe = React.useCallback((listener: () => void) => key ? machineAgentInventoryStore.subscribeAgent(key, target.agentId, listener) : () => {}, [key, target.agentId]);
    const read = React.useCallback(() => key && lifetime?.isCurrent() ? machineAgentInventoryStore.read(key).agents.find((agent) => agent.agentId === target.agentId) ?? null : null, [key, lifetime, target.agentId]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Summary reader: cache and persisted facts only unless its caller explicitly demands refresh. */
export function useMachineAgentsByMachine(target: Readonly<{ serverId: string; machineIds: readonly string[]; load?: boolean }>): ReadonlyMap<string, MachineAgentsSnapshot> {
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const idsKey = JSON.stringify([...new Set(target.machineIds)].sort());
    const machineIds = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const machineFacts = getStorage()(useShallow((state) => machineIds.flatMap((machineId) => {
        const machine = resolveServerScopedMachine(state, target.serverId, machineId);
        return [Boolean(machine && isMachineOnline(machine))];
    })));
    const projectionRevisions = useInventoryProjectionRevisions(target.serverId, machineIds);
    const cacheRef = React.useRef<ReadonlyMap<string, MachineAgentsSnapshot>>(new Map());
    const read = React.useCallback(() => {
        const previous = cacheRef.current;
        const next = new Map(machineIds.map((id) => [id, lifetime?.isCurrent() ? machineAgentInventoryStore.read(scopeKey(lifetime, id)) : EMPTY_MACHINE_AGENTS]));
        if (previous.size === next.size && [...next].every(([id, row]) => previous.get(id) === row)) return previous;
        cacheRef.current = next;
        return next;
    }, [lifetime, machineIds]);
    const subscribe = React.useCallback((listener: () => void) => {
        const disposers = lifetime ? machineIds.map((id) => machineAgentInventoryStore.subscribe(scopeKey(lifetime, id), listener)) : [];
        return () => { for (const dispose of disposers) dispose(); };
    }, [lifetime, machineIds]);
    React.useEffect(() => {
        if (!lifetime) return;
        for (const [index, machineId] of machineIds.entries()) {
            hydrate(lifetime, machineId);
            if (target.load === true) void refreshMachineAgents({ serverId: lifetime.scope.serverId, machineId, accountLifetime: lifetime });
            else {
                const inputs = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: target.serverId });
                if (machineFacts[index] !== true) observe({ lifetime, machineId, revision: getMachineContributionRegistryProjectionRevision({ serverId: target.serverId, machineId }), projection: { phase: 'idle', inputs: inputs?.kind === 'ready' ? inputs.inputs : null }, online: false });
            }
        }
    }, [lifetime, machineFacts, machineIds, projectionRevisions, target.load, target.serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
}
