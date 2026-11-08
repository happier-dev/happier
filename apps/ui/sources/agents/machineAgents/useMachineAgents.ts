import * as React from 'react';
import { shallow } from 'zustand/shallow';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryKey, projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { observeAcpCatalog, refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, subscribeMachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import { captureDaemonMergedProjectionReader, loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { useDaemonMergedProjectionInputs, type DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopedResourceKey, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isMachineSelectableForFleet, resolveFleetMachineAvailability } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachines, selectMachineInventoryRowsById } from '@/sync/domains/machines/resolveServerScopedMachines';
import { captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { buildMachineAgentInventoryDescriptors } from './machineAgentCatalog';
import { createMachineAgentInventoryPersistence } from './machineAgentInventoryPersistence';
import { projectMachineAgentCapabilityObservation } from './machineAgentCapabilityObservation';
import { machineAgentInventoryStore, EMPTY_MACHINE_AGENTS, type MachineAgentsSnapshot } from './machineAgentInventoryStore';
import { useMachineAgentAuthentication } from './useMachineAgentAuthentication';
import type { MachineAgent } from './machineAgentTypes';
import { ensureMachineAgentInstallJobs } from './installJobs/installJobStore';

export type { MachineAgentsSnapshot } from './machineAgentInventoryStore';
export type MachineAgentsTarget = Readonly<{ serverId?: string | null; machineId: string | null | undefined; agentId?: string; definitionId?: string; enabled?: boolean; load?: boolean }>;

// Retain the previous CLI-detection owner's five-minute auth-probe freshness budget.
const AUTH_PROBE_STALE_MS = 5 * 60_000;
const scopeKey = (lifetime: ServerAccountScopeLifetime, machineId: string) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents', machineId);

/** Exact-scope read for demanded Actions; never starts a refresh or exposes a retired Account. */
export function readMachineAgentsForScope(lifetime: ServerAccountScopeLifetime, machineId: string): MachineAgentsSnapshot {
    return lifetime.isCurrent() ? machineAgentInventoryStore.read(scopeKey(lifetime, machineId)) : EMPTY_MACHINE_AGENTS;
}
const capabilitySalt = (lifetime: ServerAccountScopeLifetime, revision: number) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents-capabilities', String(revision));

function useInventoryProjectionReaders(serverId: string, machineIds: readonly string[]) {
    const profilesGeneration = useServerProfilesGeneration();
    return React.useMemo(() => {
        if (machineIds.length === 0) return [];
        const resolveScopeId = captureServerProfileScopeResolver();
        return machineIds.map(machineId => captureDaemonMergedProjectionReader({ serverId, machineId }, resolveScopeId));
    }, [machineIds, profilesGeneration, serverId]);
}

function useInventoryProjectionRevisions(readers: ReturnType<typeof useInventoryProjectionReaders>): string {
    const subscribe = React.useCallback((listener: () => void) => {
        const disposers = readers.map(reader => reader.subscribeInvalidation(listener));
        return () => { for (const dispose of disposers) dispose(); };
    }, [readers]);
    const read = React.useCallback(() => JSON.stringify(readers.map(reader => reader.readRevision())), [readers]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Agent targets may include ephemeral Machines; reuse presence timing, not the persistent-picker filter. */
function useInventoryMachineFacts(serverId: string, machineIds: readonly string[], lifetime: ServerAccountScopeLifetime | null) {
    const activeServerId = useActiveServerSnapshot(machineIds.length > 0).serverId;
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) => {
        if (machineIds.length === 0) return [];
        const state = getStorage().getState();
        const machines = resolveServerScopedMachines({ serverId: serverId || activeServerId, activeServerId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, resolveScopeId);
        return selectMachineInventoryRowsById(machines, machineIds);
    }, [activeServerId, machineIds, serverId]);
    const readFacts = React.useCallback((nowMs: number) => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const scope = lifetime?.isCurrent() ? lifetime.scope : null;
        return readMachines(resolveScopeId).map(machine => Boolean(machine && isMachineSelectableForFleet(scope, machine, nowMs, resolveScopeId)));
    }, [lifetime, readMachines]);
    const targets = React.useMemo(() => [{ serverId: serverId || activeServerId, machineIds }], [serverId, activeServerId, machineIds]);
    return useMachinePresenceSnapshot(readMachines, readFacts, targets, shallow);
}

function hydrate(lifetime: ServerAccountScopeLifetime, machineId: string): void {
    if (!lifetime.isCurrent()) return;
    const key = scopeKey(lifetime, machineId);
    if (machineAgentInventoryStore.read(key) !== EMPTY_MACHINE_AGENTS) return;
    const saved = createMachineAgentInventoryPersistence(getPersistenceStorage()).read(lifetime.scope, machineId);
    if (saved) machineAgentInventoryStore.publish(key, { ...saved, status: 'offline' });
}

function observe(input: Readonly<{ lifetime: ServerAccountScopeLifetime; machineId: string; revision: number; projection: DaemonMergedProjectionInputsState;
    authentication?: ReturnType<typeof useMachineAgentAuthentication> }>): void {
    if (!input.lifetime.isCurrent()) return;
    const key = scopeKey(input.lifetime, input.machineId);
    // Re-read the qualified fact at publication, including async/cache callbacks.
    const machine = resolveServerScopedMachine(getStorage().getState(), input.lifetime.scope.serverId, input.machineId);
    const online = Boolean(machine && isMachineSelectableForFleet(input.lifetime.scope, machine));
    const catalog = getAcpCatalogSnapshot(input.lifetime.scope);
    const definitionInventory = projectAcpCatalogForMachineInventory(catalog?.catalog, catalog?.data?.definitions);
    const previous = machineAgentInventoryStore.read(key);
    const definitionDescriptors = new Map(buildMachineAgentInventoryDescriptors({ pluginProjectionV2: { agentsById: {} },
        definitions: definitionInventory.definitions }).map(descriptor => [descriptor.definitionId, descriptor]));
    if (definitionInventory.definitionCatalog) for (const agent of previous.agents) {
        if (agent.definitionId && !definitionDescriptors.has(agent.definitionId)) definitionDescriptors.set(agent.definitionId, {
            agentId: agent.agentId, definitionId: agent.definitionId, title: agent.title,
        });
    }
    const descriptors = input.projection.inputs ? [...buildMachineAgentInventoryDescriptors(input.projection.inputs), ...definitionDescriptors.values()] : undefined;
    const failed = input.projection.phase === 'error' || input.projection.phase === 'unsupported';
    const observation = online && descriptors && !failed
        ? descriptors.length === 0 && input.projection.phase === 'ready'
            ? { status: 'ready' as const, items: [], descriptors, lastCheckedAt: machineAgentInventoryStore.read(key).lastCheckedAt ?? Date.now() }
            : projectMachineAgentCapabilityObservation(descriptors,
            getMachineCapabilitiesCacheState(input.machineId, input.lifetime.scope.serverId, capabilitySalt(input.lifetime, input.revision), input.lifetime.scope.accountId),
            machineAgentInventoryStore.read(key).agents, definitionInventory)
        : { status: !online ? 'offline' as const : failed ? 'error' as const : input.projection.phase === 'idle' ? 'idle' as const : 'loading' as const, items: [], lastCheckedAt: null, ...(descriptors ? { descriptors } : {}) };
    const dependencyTitlesByKey = Object.fromEntries(getInstallablesRegistryEntries({ pluginProjection: input.projection.inputs?.pluginProjectionV2 ?? undefined }).map((entry) => [entry.key, entry.title]));
    const unavailableDefinitions = definitionInventory.definitionCatalog ? [...definitionDescriptors.values()].map(descriptor => ({
        agentId: descriptor.agentId, definitionId: descriptor.definitionId, reason: 'probe_failed' as const,
        errorCode: definitionInventory.definitionCatalog?.reason,
    })) : [];
    machineAgentInventoryStore.publish(key, { ...observation,
        installedAgentsCheckedAt: machine?.metadata?.agentInventory?.checkedAt,
        ...(unavailableDefinitions.length ? { unavailable: [...('unavailable' in observation ? observation.unavailable ?? [] : []), ...unavailableDefinitions] } : {}),
        dependencyTitlesByKey, ...input.authentication?.(input.projection) });
    if (observation.status === 'ready' && observation.lastCheckedAt !== null) {
        createMachineAgentInventoryPersistence(getPersistenceStorage()).write(input.lifetime.scope, input.machineId, { items: [...observation.items], lastCheckedAt: observation.lastCheckedAt });
    }
}

/** Shared inventory/selected-Agent refresh; the credential lifetime, never focused Home, owns transport. */
export async function refreshMachineAgents(input: Readonly<{ serverId: string; machineId: string; accountLifetime: ServerAccountScopeLifetime; agentId?: string; definitionId?: string; force?: boolean; signal?: AbortSignal; retryWhileObserved?: AbortSignal }>): Promise<void> {
    const lifetime = input.accountLifetime;
    if (input.signal?.aborted || !lifetime.isCurrent() || lifetime.scope.serverId !== input.serverId) return;
    hydrate(lifetime, input.machineId);
    const machine = resolveServerScopedMachine(getStorage().getState(), input.serverId, input.machineId);
    const availability = machine ? resolveFleetMachineAvailability(lifetime.scope, machine) : null;
    const canRefresh = availability === 'online' || (input.force === true && availability === 'offline');
    const scope = { machineId: input.machineId, serverId: input.serverId };
    const revision = getMachineContributionRegistryProjectionRevision(scope);
    if (!canRefresh) { observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'idle', inputs: null } }); return; }
    // Projection publications also wake inventory readers. Reuse that admitted
    // answer so observing it cannot trigger another describe/publication cycle.
    const entry = await loadDaemonMergedProjectionCacheEntry({ ...scope, accountLifetime: lifetime, reuseFreshReady: input.force !== true, signal: input.signal });
    if (input.signal?.aborted || !lifetime.isCurrent()) return;
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    const inputs = entry?.kind === 'ready' || entry?.kind === 'error' ? entry.inputs ?? null : null;
    const agents = buildMachineAgentInventoryDescriptors(inputs);
    if (entry?.kind !== 'ready' || !inputs) {
        observe({ lifetime, machineId: input.machineId, revision, projection: { phase: entry?.kind === 'unsupported' ? 'unsupported' : 'error', inputs } });
        return;
    }
    if (!input.agentId || input.definitionId) {
        const catalog = getAcpCatalogSnapshot(lifetime.scope);
        if (!catalog || catalog.stale || input.force) await refreshAcpCatalog(lifetime.scope);
        if (input.signal?.aborted || !lifetime.isCurrent()) return;
    }
    const catalog = getAcpCatalogSnapshot(lifetime.scope);
    const definitionInventory: ReturnType<typeof projectAcpCatalogForMachineInventory> = !input.agentId || input.definitionId
        ? projectAcpCatalogForMachineInventory(catalog?.catalog, catalog?.data?.definitions) : {};
    const definitions = definitionInventory.definitions?.filter(definition => !input.definitionId || definition.definitionId === input.definitionId);
    if (agents.length === 0 && !definitions?.length) {
        observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs } });
        return;
    }
    const requestedAgents = input.agentId ? agents.filter((agent) => agent.agentId === input.agentId) : agents;
    if (requestedAgents.length === 0 && !definitions?.length) return;
    const args = { machineId: input.machineId, serverId: input.serverId, accountLifetime: lifetime, signal: input.signal,
        retryWhileObserved: input.retryWhileObserved, cacheKeySalt: capabilitySalt(lifetime, revision), request: buildMachineAgentsDetectRequest({
        agents: requestedAgents, refresh: input.force,
        ...definitionInventory, ...(definitions ? { definitions } : {}),
        // Send needs installation and authentication, not a vendor's latest release.
        // The open picker still enriches this same snapshot with update facts.
        includeLatestVersion: !input.agentId,
    }) };
    await Promise.all([
        // Older daemons can still report inventory facts when install jobs are unavailable.
        ensureMachineAgentInstallJobs({ ...lifetime.scope, machineId: input.machineId }, { signal: input.signal }).catch(() => {}),
        input.force ? prefetchMachineCapabilities(args) : prefetchMachineCapabilitiesIfStale({ ...args, staleMs: AUTH_PROBE_STALE_MS }),
    ]);
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs } });
}

function useInventoryDriver(target: MachineAgentsTarget) {
    const activeServer = useActiveServerSnapshot(!target.serverId);
    const requestedServerId = target.serverId?.trim() || activeServer.serverId;
    const machineId = target.machineId?.trim() || '';
    const agentId = target.agentId?.trim() || undefined;
    const definitionId = target.definitionId;
    const enabled = target.enabled !== false && Boolean(machineId && requestedServerId);
    const { binding } = useServerCredentialAccountScopeBinding(requestedServerId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const serverId = lifetime?.scope.serverId ?? requestedServerId;
    const key = enabled && lifetime ? scopeKey(lifetime, machineId) : null;
    const reachabilityRevision = useMachineReachabilityRevision(enabled);
    const machineIds = React.useMemo(() => enabled ? [machineId] : [], [enabled, machineId]);
    const online = useInventoryMachineFacts(serverId, machineIds, lifetime)[0] === true;
    const projectionReaders = useInventoryProjectionReaders(serverId, machineIds);
    const projectionRevisions = useInventoryProjectionRevisions(projectionReaders);
    const revision = enabled ? projectionReaders[0]!.readRevision() : 0;
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, enabled, load: enabled && online && target.load !== false });
    const readAcp = React.useCallback(() => lifetime ? getAcpCatalogSnapshot(lifetime.scope) : null, [lifetime]);
    const acpCatalog = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
    React.useEffect(() => enabled && lifetime && target.load !== false && (!agentId || definitionId)
        ? observeAcpCatalog(lifetime.scope) : undefined, [agentId, definitionId, enabled, lifetime, target.load]);
    const authentication = useMachineAgentAuthentication({ lifetime, serverId, sourceMachineId: machineId,
        enabled: enabled && Object.values(projection.inputs?.pluginProjectionV2?.agentsById ?? {}).some(agent => agent.connectedAccounts?.length) });
    React.useEffect(() => {
        if (!lifetime || !key) return;
        hydrate(lifetime, machineId);
        const publish = () => observe({ lifetime, machineId, revision, projection, authentication });
        publish();
        const unsubscribe = subscribeMachineCapabilitiesCacheState(machineId, serverId, capabilitySalt(lifetime, revision), publish, lifetime.scope.accountId);
        return unsubscribe;
    }, [acpCatalog, authentication, key, lifetime, online, reachabilityRevision, revision, machineId, projection.inputs, projection.phase, serverId]);
    React.useEffect(() => {
        if (!lifetime || !enabled || !online || target.load === false) return;
        const abort = new AbortController();
        // This enabled inventory remains a detection consumer after acquisition;
        // its existing effect lifetime, unlike a finite Action, owns recovery.
        void refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId, definitionId,
            signal: abort.signal, retryWhileObserved: abort.signal });
        return () => abort.abort();
    }, [acpCatalog?.data, agentId, definitionId, enabled, lifetime, online, projectionRevisions, machineId, projection.inputs, serverId, target.load]);
    const refreshAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => refreshAbort.current?.abort(), [agentId, definitionId, enabled, lifetime, machineId, serverId, target.load]);
    const refresh = React.useCallback(async () => {
        refreshAbort.current?.abort();
        const abort = new AbortController();
        refreshAbort.current = abort;
        if (enabled && lifetime) await refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId, definitionId,
            force: true, signal: abort.signal });
    }, [agentId, definitionId, enabled, lifetime, machineId, serverId]);
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
    const targetKey = buildMachineAgentInventoryKey(target);
    const subscribe = React.useCallback((listener: () => void) => key ? machineAgentInventoryStore.subscribeAgent(key, target.agentId, listener, target.definitionId) : () => {}, [key, target.agentId, target.definitionId]);
    const read = React.useCallback(() => key && lifetime?.isCurrent() ? machineAgentInventoryStore.read(key).agents.find((agent) => buildMachineAgentInventoryKey(agent) === targetKey) ?? null : null, [key, lifetime, targetKey]);
    return React.useSyncExternalStore(subscribe, read, read);
}

/** Explicit per-machine retry for multi-machine surfaces; mounting this hook never probes inventory. */
export function useRefreshMachineAgents(serverId: string): (machineId: string) => Promise<void> {
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const requests = React.useRef(new Map<string, AbortController>());
    React.useEffect(() => () => {
        for (const abort of requests.current.values()) abort.abort();
        requests.current.clear();
    }, [binding]);
    return React.useCallback(async (machineId: string) => {
        const id = machineId.trim();
        if (!id || !binding?.isCurrent()) return;
        requests.current.get(id)?.abort();
        const abort = new AbortController();
        requests.current.set(id, abort);
        try {
            await refreshMachineAgents({ serverId: binding.scope.serverId, machineId: id, accountLifetime: binding, force: true, signal: abort.signal });
        } finally {
            if (requests.current.get(id) === abort) requests.current.delete(id);
        }
    }, [binding]);
}

/** Summary reader: cache and persisted facts only unless its caller explicitly demands refresh. */
export function useMachineAgentsByMachine(target: Readonly<{ serverId: string; machineIds: readonly string[]; load?: boolean }>): ReadonlyMap<string, MachineAgentsSnapshot> {
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const idsKey = JSON.stringify([...new Set(target.machineIds)].sort());
    const machineIds = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    const reachabilityRevision = useMachineReachabilityRevision(machineIds.length > 0);
    const machineFacts = useInventoryMachineFacts(target.serverId, machineIds, lifetime);
    const projectionReaders = useInventoryProjectionReaders(target.serverId, machineIds);
    const projectionRevisions = useInventoryProjectionRevisions(projectionReaders);
    const authentication = useMachineAgentAuthentication({ lifetime, serverId: target.serverId,
        enabled: projectionReaders.some(reader => {
            const cached = reader.readCached();
            return (cached?.kind === 'ready' || cached?.kind === 'error')
                && Object.values(cached.inputs?.pluginProjectionV2?.agentsById ?? {}).some(agent => agent.connectedAccounts?.length);
        }) });
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
        if (!lifetime || target.load !== true) return;
        const abort = new AbortController();
        for (const machineId of machineIds) {
            void refreshMachineAgents({ serverId: lifetime.scope.serverId, machineId, accountLifetime: lifetime, signal: abort.signal });
        }
        return () => abort.abort();
    }, [lifetime, machineFacts, machineIds, projectionRevisions, reachabilityRevision, target.load, target.serverId]);
    React.useEffect(() => {
        if (!lifetime) return;
        for (const [index, machineId] of machineIds.entries()) {
            hydrate(lifetime, machineId);
            const inputs = projectionReaders[index]!.readCached();
            if (machineFacts[index] !== true || inputs?.kind === 'ready' || inputs?.kind === 'error') {
                observe({ lifetime, machineId, authentication, revision: projectionReaders[index]!.readRevision(),
                    projection: { phase: inputs?.kind === 'ready' || inputs?.kind === 'error' ? inputs.kind : 'idle',
                        inputs: inputs?.kind === 'ready' || inputs?.kind === 'error' ? inputs.inputs ?? null : null } });
            }
        }
    }, [authentication, lifetime, machineFacts, machineIds, projectionReaders, projectionRevisions, reachabilityRevision, target.load, target.serverId]);
    return React.useSyncExternalStore(subscribe, read, read);
}
