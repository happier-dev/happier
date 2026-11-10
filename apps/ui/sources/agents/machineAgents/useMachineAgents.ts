import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { shallow } from 'zustand/shallow';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryKey, projectAcpCatalogForMachineInventory } from '@happier-dev/protocol/capabilities';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import { observeAcpCatalog, refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getMachineCapabilitiesCacheState, prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale, subscribeMachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import { captureDaemonMergedProjectionReader, loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { getMachineContributionRegistryProjectionRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import { useDaemonMergedProjectionInputs, type DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { getStorage } from '@/sync/domains/state/storage';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
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
import { ensureMachineAgentInstallJobs, subscribeAgentInstallJob, subscribeMachineAgentInstallJobs } from './installJobs/installJobStore';

export type { MachineAgentsSnapshot } from './machineAgentInventoryStore';
export type MachineAgentsTarget = Readonly<{ serverId?: string | null; machineId: string | null | undefined; agentId?: string; definitionId?: string; enabled?: boolean; load?: boolean }>;

// Retain the previous CLI-detection owner's five-minute auth-probe freshness budget.
const AUTH_PROBE_STALE_MS = 5 * 60_000;
// Credential readiness consumes the Agent's exact Connected Account authentication declaration.
const INVENTORY_PROJECTION_SECTIONS = ['agentsById', 'familiesById.connectedAccounts'] as const;
const scopeKey = (lifetime: ServerAccountScopeLifetime, machineId: string) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents', machineId);

/** Exact-scope read for demanded Actions; never starts a refresh or exposes a retired Account. */
export function readMachineAgentsForScope(lifetime: ServerAccountScopeLifetime, machineId: string): MachineAgentsSnapshot {
    return lifetime.isCurrent() ? machineAgentInventoryStore.read(scopeKey(lifetime, machineId), () => {
        const saved = createMachineAgentInventoryPersistence(getPersistenceStorage()).read(lifetime.scope, machineId);
        return saved ? { ...saved, status: 'offline' } : null;
    }) : EMPTY_MACHINE_AGENTS;
}

/** Observe already-produced readiness without acquiring catalogs, probes, or executable runtimes. */
export function useObservedMachineAgents(target: Pick<MachineAgentsTarget, 'serverId' | 'machineId'>): MachineAgentsSnapshot {
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId ?? '');
    const machineId = target.machineId?.trim() ?? '';
    const lifetime = binding?.isCurrent() ? binding : null;
    const key = lifetime && machineId ? scopeKey(lifetime, machineId) : null;
    const subscribe = React.useCallback((listener: () => void) => key
        ? machineAgentInventoryStore.subscribe(key, listener) : () => {}, [key]);
    const read = React.useCallback(() => lifetime && key
        ? readMachineAgentsForScope(lifetime, machineId) : EMPTY_MACHINE_AGENTS, [key, lifetime, machineId]);
    return React.useSyncExternalStore(subscribe, read, read);
}
const capabilitySalt = (lifetime: ServerAccountScopeLifetime, revision: number) => serverAccountScopedResourceKey(lifetime.scope, 'machine-agents-capabilities', String(revision));

function useInventoryProjectionReaders(serverId: string, machineIds: readonly string[]) {
    const profilesGeneration = useServerProfilesGeneration();
    return React.useMemo(() => {
        if (machineIds.length === 0) return [];
        const resolveScopeId = captureServerProfileScopeResolver();
        return machineIds.map(machineId => captureDaemonMergedProjectionReader({ serverId, machineId, sections: INVENTORY_PROJECTION_SECTIONS }, resolveScopeId));
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

function readInventoryMachines(serverId: string, activeServerId: string, machineIds: readonly string[], resolveScopeId: ProfileScopeResolver) {
    if (machineIds.length === 0) return [];
    const state = getStorage().getState();
    const machines = resolveServerScopedMachines({ serverId: serverId || activeServerId, activeServerId,
        get activeMachines() { return Object.values(state.machines); },
        machineListByServerId: state.machineListByServerId,
        machineListStatusByServerId: state.machineListStatusByServerId,
    }, resolveScopeId);
    return selectMachineInventoryRowsById(machines, machineIds);
}

/** Agent targets may include ephemeral Machines; reuse presence timing, not the persistent-picker filter. */
function useInventoryMachineFacts(serverId: string, machineIds: readonly string[], lifetime: ServerAccountScopeLifetime | null) {
    const activeServerId = useActiveServerSnapshot(machineIds.length > 0).serverId;
    const cached = React.useRef<readonly Readonly<{ online: boolean; installedAgentIds?: readonly string[] }>[]>([]);
    const readMachines = React.useCallback((resolveScopeId: ProfileScopeResolver = captureServerProfileScopeResolver()) =>
        readInventoryMachines(serverId || activeServerId, activeServerId, machineIds, resolveScopeId), [activeServerId, machineIds, serverId]);
    const readFacts = React.useCallback((nowMs: number) => {
        const resolveScopeId = captureServerProfileScopeResolver();
        const scope = lifetime?.isCurrent() ? lifetime.scope : null;
        return cached.current = retainDeep(cached.current, readMachines(resolveScopeId).map(machine => ({
            online: Boolean(machine && isMachineSelectableForFleet(scope, machine, nowMs, resolveScopeId)),
            installedAgentIds: machine?.metadata?.agentInventory?.installedAgentIds,
        })));
    }, [lifetime, readMachines]);
    const targets = React.useMemo(() => [{ serverId: serverId || activeServerId, machineIds }], [serverId, activeServerId, machineIds]);
    return useMachinePresenceSnapshot(readMachines, readFacts, targets, shallow);
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
    const previous = readMachineAgentsForScope(input.lifetime, input.machineId);
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
        : { status: !online ? 'offline' as const : failed ? 'error' as const : input.projection.phase === 'idle' ? 'idle' as const : 'loading' as const, items: [], lastCheckedAt: null, ...(descriptors ? { descriptors } : {}),
            ...(online && failed ? { failure: { reason: 'probe_failed' as const,
                errorCode: input.projection.failureReason ?? (input.projection.phase === 'unsupported' ? 'not-supported' : 'error') } } : {}) };
    const dependencyTitlesByKey = Object.fromEntries(getInstallablesRegistryEntries({ pluginProjection: input.projection.inputs?.pluginProjectionV2 ?? undefined }).map((entry) => [entry.key, entry.title]));
    const unavailableDefinitions = definitionInventory.definitionCatalog ? [...definitionDescriptors.values()].map(descriptor => ({
        agentId: descriptor.agentId, definitionId: descriptor.definitionId, reason: 'probe_failed' as const,
        errorCode: definitionInventory.definitionCatalog?.reason,
    })) : [];
    machineAgentInventoryStore.publish(key, { ...observation,
        installedAgentIds: machine?.metadata?.agentInventory?.installedAgentIds,
        installedAgentsCheckedAt: machine?.metadata?.agentInventory?.checkedAt,
        ...(unavailableDefinitions.length ? { unavailable: [...('unavailable' in observation ? observation.unavailable ?? [] : []), ...unavailableDefinitions] } : {}),
        dependencyTitlesByKey, ...input.authentication?.(input.projection) });
    if (observation.status === 'ready' && observation.lastCheckedAt !== null) {
        const items = machineAgentInventoryStore.readObservedItems(key, observation.items);
        createMachineAgentInventoryPersistence(getPersistenceStorage()).write(input.lifetime.scope, input.machineId, { items: [...items], lastCheckedAt: observation.lastCheckedAt });
    }
}

/** Shared inventory/selected-Agent refresh; the credential lifetime, never focused Home, owns transport. */
export async function refreshMachineAgents(input: Readonly<{ serverId: string; machineId: string; accountLifetime: ServerAccountScopeLifetime; agentId?: string; definitionId?: string; force?: boolean; signal?: AbortSignal; retryWhileObserved?: AbortSignal }>): Promise<void> {
    const lifetime = input.accountLifetime;
    if (input.signal?.aborted || !lifetime.isCurrent() || lifetime.scope.serverId !== input.serverId) return;
    readMachineAgentsForScope(lifetime, input.machineId);
    const machine = resolveServerScopedMachine(getStorage().getState(), input.serverId, input.machineId);
    const availability = machine ? resolveFleetMachineAvailability(lifetime.scope, machine) : null;
    const canRefresh = availability === 'online' || (input.force === true && availability === 'offline');
    const scope = { machineId: input.machineId, serverId: input.serverId };
    const revision = getMachineContributionRegistryProjectionRevision(scope);
    if (!canRefresh) { observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'idle', inputs: null } }); return; }
    // Projection publications also wake inventory readers. Reuse that admitted
    // answer so observing it cannot trigger another describe/publication cycle.
    const entry = await loadDaemonMergedProjectionCacheEntry({ ...scope, sections: INVENTORY_PROJECTION_SECTIONS, accountLifetime: lifetime, reuseFreshReady: input.force !== true, signal: input.signal });
    if (input.signal?.aborted || !lifetime.isCurrent()) return;
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    const inputs = entry?.kind === 'ready' || entry?.kind === 'error' ? entry.inputs ?? null : null;
    const agents = buildMachineAgentInventoryDescriptors(inputs);
    if (entry?.kind !== 'ready' || !inputs) {
        observe({ lifetime, machineId: input.machineId, revision, projection: { phase: entry?.kind === 'unsupported' ? 'unsupported' : 'error', inputs,
            ...(entry?.kind === 'error' ? { failureReason: entry.reason } : {}) } });
        return;
    }
    const requestedAgents = input.agentId ? agents.filter((agent) => agent.agentId === input.agentId) : agents;
    if (input.agentId && requestedAgents.length === 0 && !input.definitionId) return;
    const needsDefinitions = !input.agentId || Boolean(input.definitionId);
    const catalog = needsDefinitions ? getAcpCatalogSnapshot(lifetime.scope) : null;
    // Account definitions and daemon-native executables have independent authorities.
    // Keep the catalog demanded without holding native readiness behind its HTTP read.
    const catalogRefresh = needsDefinitions && (!catalog || catalog.stale || input.force)
        ? refreshAcpCatalog(lifetime.scope) : null;
    const readDefinitions = (): ReturnType<typeof projectAcpCatalogForMachineInventory> => {
        if (!needsDefinitions) return {};
        const current = getAcpCatalogSnapshot(lifetime.scope);
        const inventory = projectAcpCatalogForMachineInventory(current?.catalog, current?.data?.definitions);
        return { ...inventory, ...(inventory.definitions ? { definitions: inventory.definitions.filter(definition =>
            !input.definitionId || definition.definitionId === input.definitionId) } : {}) };
    };
    const admittedDefinitions = catalogRefresh ? undefined : readDefinitions();
    const hasAdmittedInventory = requestedAgents.length > 0 || Boolean(admittedDefinitions?.definitions?.length);
    // An empty authoritative roster has neither executable probes nor install jobs.
    // Cold definitions acquire jobs only after their actual catalog admission.
    const refreshInstallJobs = () => ensureMachineAgentInstallJobs({ ...lifetime.scope, machineId: input.machineId },
        { signal: input.signal }).catch(() => {});
    const refreshCapabilities = (request: ReturnType<typeof buildMachineAgentsDetectRequest>) => {
        const args = { machineId: input.machineId, serverId: input.serverId, accountLifetime: lifetime, signal: input.signal,
            retryWhileObserved: input.retryWhileObserved, cacheKeySalt: capabilitySalt(lifetime, revision), request };
        return input.force ? prefetchMachineCapabilities(args)
            : prefetchMachineCapabilitiesIfStale({ ...args, staleMs: AUTH_PROBE_STALE_MS });
    };
    await Promise.all([
        // Older daemons can still report inventory facts when install jobs are unavailable.
        hasAdmittedInventory ? refreshInstallJobs() : Promise.resolve(),
        (async () => {
            // Installation and authentication settle independently of optional vendor release lookups.
            if (requestedAgents.length || admittedDefinitions?.definitions?.length && !admittedDefinitions.definitionCatalog) {
                await refreshCapabilities(buildMachineAgentsDetectRequest({
                    agents: requestedAgents, refresh: input.force, includeLatestVersion: false,
                    ...(admittedDefinitions?.definitions?.length ? admittedDefinitions : {}),
                }));
            }
            if (input.signal?.aborted || !lifetime.isCurrent()
                || getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
            observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs } });
            if (catalogRefresh) await catalogRefresh;
            if (input.signal?.aborted || !lifetime.isCurrent()
                || getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
            const lateDefinitions = catalogRefresh ? readDefinitions() : undefined;
            if (lateDefinitions?.definitions?.length && !lateDefinitions.definitionCatalog) {
                await Promise.all([
                    hasAdmittedInventory ? Promise.resolve() : refreshInstallJobs(),
                    refreshCapabilities(buildMachineAgentsDetectRequest({ agents: [], refresh: input.force,
                        ...lateDefinitions, includeLatestVersion: false })),
                ]);
                if (input.signal?.aborted || !lifetime.isCurrent()
                    || getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
                observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs } });
            }
            // Enrich the same admitted cache only for a demanded full inventory. A failed
            // readiness probe retains its own failure/recovery policy, not a second probe here.
            const observed = machineAgentInventoryStore.read(scopeKey(lifetime, input.machineId));
            if (!input.agentId && observed.status === 'ready') {
                const installedKeys = new Set(observed.agents.filter(agent => agent.installed && !agent.stale).map(buildMachineAgentInventoryKey));
                const updateAgents = requestedAgents.filter(agent => installedKeys.has(buildMachineAgentInventoryKey(agent)));
                if (updateAgents.length) await refreshCapabilities(buildMachineAgentsDetectRequest({
                    agents: updateAgents, refresh: input.force, includeLatestVersion: true,
                }));
            }
        })(),
    ]);
    if (getMachineContributionRegistryProjectionRevision(scope) !== revision) return;
    observe({ lifetime, machineId: input.machineId, revision, projection: { phase: 'ready', inputs } });
}

function useInventoryDriver(target: MachineAgentsTarget) {
    const presented = useLayoutPresentationActive();
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
    React.useEffect(() => {
        if (!presented || !enabled || !lifetime || target.load === false) return;
        const scope = { ...lifetime.scope, machineId };
        // Job changes already publish through the inventory store. This only
        // retains demand at the same poll owner while the inventory is visible.
        return agentId ? subscribeAgentInstallJob({ ...scope, agentId, definitionId }, () => {})
            : subscribeMachineAgentInstallJobs(scope, () => {});
    }, [agentId, definitionId, enabled, lifetime, machineId, presented, target.load]);
    const reachabilityRevision = useMachineReachabilityRevision(enabled, lifetime?.scope, machineId);
    const machineIds = React.useMemo(() => enabled ? [machineId] : [], [enabled, machineId]);
    const machineFact = useInventoryMachineFacts(serverId, machineIds, lifetime)[0];
    const online = machineFact?.online === true;
    const installedAgentIds = machineFact?.installedAgentIds;
    const projectionReaders = useInventoryProjectionReaders(serverId, machineIds);
    const projectionRevisions = useInventoryProjectionRevisions(projectionReaders);
    const revision = enabled ? projectionReaders[0]!.readRevision() : 0;
    const projection = useDaemonMergedProjectionInputs({ machineId, serverId, sections: INVENTORY_PROJECTION_SECTIONS, enabled, load: enabled && online && target.load !== false });
    const readAcp = React.useCallback(() => lifetime ? getAcpCatalogSnapshot(lifetime.scope) : null, [lifetime]);
    const acpCatalog = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
    React.useEffect(() => enabled && lifetime && target.load !== false && (!agentId || definitionId)
        ? observeAcpCatalog(lifetime.scope) : undefined, [agentId, definitionId, enabled, lifetime, target.load]);
    const authentication = useMachineAgentAuthentication({ lifetime, serverId, sourceMachineId: machineId,
        enabled: enabled && Object.values(projection.inputs?.pluginProjectionV2?.agentsById ?? {}).some(agent => agent.connectedAccounts?.length) });
    React.useEffect(() => {
        if (!lifetime || !key) return;
        const publish = () => observe({ lifetime, machineId, revision, projection, authentication });
        publish();
        const unsubscribe = subscribeMachineCapabilitiesCacheState(machineId, serverId, capabilitySalt(lifetime, revision), publish, lifetime.scope.accountId);
        return unsubscribe;
    }, [acpCatalog, authentication, installedAgentIds, key, lifetime, online, reachabilityRevision, revision, machineId, projection.inputs, projection.phase, projection.failureReason, serverId]);
    React.useEffect(() => {
        if (!presented || !lifetime || !enabled || !online || target.load === false) return;
        const abort = new AbortController();
        // This enabled inventory remains a detection consumer after acquisition;
        // its existing effect lifetime, unlike a finite Action, owns recovery.
        // Registry invalidation renews demand; publishing the projection this
        // acquisition loaded must not cancel and restart that same demand.
        void refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId, definitionId,
            signal: abort.signal, retryWhileObserved: abort.signal });
        return () => abort.abort();
    }, [acpCatalog?.data, agentId, definitionId, enabled, lifetime, online, presented, projectionRevisions, machineId, serverId, target.load]);
    const refreshAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => refreshAbort.current?.abort(), [agentId, definitionId, enabled, lifetime, machineId, serverId, target.load]);
    const refresh = React.useCallback(async () => {
        refreshAbort.current?.abort();
        const abort = new AbortController();
        refreshAbort.current = abort;
        if (enabled && lifetime) await refreshMachineAgents({ serverId, machineId, accountLifetime: lifetime, agentId, definitionId,
            force: true, signal: abort.signal });
    }, [agentId, definitionId, enabled, lifetime, machineId, serverId]);
    return { key, lifetime, machineId, refresh };
}

export function useMachineAgents(target: MachineAgentsTarget): MachineAgentsSnapshot & Readonly<{ refresh(): Promise<void> }> {
    const { key, lifetime, machineId, refresh } = useInventoryDriver(target);
    const subscribe = React.useCallback((listener: () => void) => key ? machineAgentInventoryStore.subscribe(key, listener) : () => {}, [key]);
    const read = React.useCallback(() => key && lifetime ? readMachineAgentsForScope(lifetime, machineId) : EMPTY_MACHINE_AGENTS, [key, lifetime, machineId]);
    const snapshot = React.useSyncExternalStore(subscribe, read, read);
    return React.useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot]);
}

export function useMachineAgent(target: MachineAgentsTarget & Readonly<{ agentId: string }>): MachineAgent | null {
    const { key, lifetime, machineId } = useInventoryDriver(target);
    const targetKey = buildMachineAgentInventoryKey(target);
    const subscribe = React.useCallback((listener: () => void) => key ? machineAgentInventoryStore.subscribeAgent(key, target.agentId, listener, target.definitionId) : () => {}, [key, target.agentId, target.definitionId]);
    const read = React.useCallback(() => key && lifetime ? readMachineAgentsForScope(lifetime, machineId).agents.find((agent) => buildMachineAgentInventoryKey(agent) === targetKey) ?? null : null, [key, lifetime, machineId, targetKey]);
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

type MachineAgentsByMachineTarget = Readonly<{
    serverId: string;
    machineIds: readonly string[];
    load?: boolean;
    /** The host's own Updates authority, for selection only; never changes inventory presence or refresh eligibility. */
    alwaysOnlineMachineId?: string | null;
}>;

export type MachineAgentUpdateFact = Pick<MachineAgent,
    'agentId' | 'definitionId' | 'title' | 'state' | 'installed' | 'version' | 'latestVersion' | 'update' | 'stale'>
    & Readonly<{ platform: Readonly<{ supported: boolean }> }>;

/**
 * Updates refuse every remote action while the Machine is unavailable, so an
 * inventory's subsequent stale publication adds no refusal fact. This only
 * selects relevant facts; actual inventory status/staleness is never changed.
 * Once online again (or for this host's own authority), still-stale inventory
 * remains stale until its real refresh succeeds.
 */
export function selectMachineAgentUpdateFacts(
    snapshot: MachineAgentsSnapshot,
    previousRows: readonly MachineAgentUpdateFact[] | undefined,
    online: boolean,
): readonly MachineAgentUpdateFact[] {
    const previousById = new Map(previousRows?.map(agent => [buildMachineAgentInventoryKey(agent), agent]));
    const rows = snapshot.agents.map((agent): MachineAgentUpdateFact => {
        const previous = previousById.get(buildMachineAgentInventoryKey(agent));
        const stale = online && agent.stale;
        const update = agent.update;
        const sameUpdate = update === null ? previous?.update === null
            : previous?.update != null && update.supported === previous.update.supported && update.command === previous.update.command;
        if (previous && previous.agentId === agent.agentId && previous.definitionId === agent.definitionId
            && previous.title === agent.title && previous.state === agent.state && previous.installed === agent.installed
            && previous.version === agent.version && previous.latestVersion === agent.latestVersion
            && sameUpdate && previous.platform.supported === agent.platform.supported && previous.stale === stale) return previous;
        return {
            agentId: agent.agentId,
            definitionId: agent.definitionId,
            title: agent.title,
            state: agent.state,
            installed: agent.installed,
            version: agent.version,
            latestVersion: agent.latestVersion,
            update: update ? { supported: update.supported, command: update.command } : null,
            platform: { supported: agent.platform.supported },
            stale,
        };
    });
    return previousRows && rows.length === previousRows.length && rows.every((row, index) => row === previousRows[index])
        ? previousRows : rows;
}

/** Summary reader: cache and persisted facts only unless its caller explicitly demands refresh. */
export function useMachineAgentsByMachine(target: MachineAgentsByMachineTarget, select?: undefined): ReadonlyMap<string, MachineAgentsSnapshot>;
export function useMachineAgentsByMachine<T>(target: MachineAgentsByMachineTarget,
    select: (snapshot: MachineAgentsSnapshot, previous: T | undefined, online: boolean) => T): ReadonlyMap<string, T>;
export function useMachineAgentsByMachine<T>(
    target: MachineAgentsByMachineTarget,
    select?: (snapshot: MachineAgentsSnapshot, previous: T | undefined, online: boolean) => T,
): ReadonlyMap<string, T | MachineAgentsSnapshot> {
    const presented = useLayoutPresentationActive();
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const lifetime = binding?.isCurrent() ? binding : null;
    const idsKey = JSON.stringify([...new Set(target.machineIds)].sort());
    const machineIds = React.useMemo(() => JSON.parse(idsKey) as string[], [idsKey]);
    React.useEffect(() => {
        if (!presented || !lifetime || target.load !== true) return;
        const disposers = machineIds.map(machineId => subscribeMachineAgentInstallJobs({ ...lifetime.scope, machineId }, () => {}));
        return () => { for (const dispose of disposers) dispose(); };
    }, [lifetime, machineIds, presented, target.load]);
    // Only this Home and Account's observations can change what these Machines' inventories show.
    const reachabilityRevision = useMachineReachabilityRevision(machineIds.length > 0, lifetime?.scope);
    const machineFacts = useInventoryMachineFacts(target.serverId, machineIds, lifetime);
    const alwaysOnlineMachineId = target.alwaysOnlineMachineId?.trim() || null;
    const projectionReaders = useInventoryProjectionReaders(target.serverId, machineIds);
    const projectionRevisions = useInventoryProjectionRevisions(projectionReaders);
    const authentication = useMachineAgentAuthentication({ lifetime, serverId: target.serverId,
        enabled: projectionReaders.some(reader => {
            const cached = reader.readCached();
            return (cached?.kind === 'ready' || cached?.kind === 'error')
                && Object.values(cached.inputs?.pluginProjectionV2?.agentsById ?? {}).some(agent => agent.connectedAccounts?.length);
        }) });
    type SummaryInput = Readonly<{ snapshot: MachineAgentsSnapshot; online: boolean }>;
    const published = React.useRef<Readonly<{
        lifetime: typeof lifetime; select: typeof select; alwaysOnlineMachineId: typeof alwaysOnlineMachineId;
        inputs: ReadonlyMap<string, SummaryInput>; value(): ReadonlyMap<string, T | MachineAgentsSnapshot>;
    }> | null>(null);
    const summary = React.useMemo(() => {
        const previous = published.current;
        const retained = previous && previous.lifetime === lifetime && previous.select === select
            && previous.alwaysOnlineMachineId === alwaysOnlineMachineId ? previous : null;
        const previousValue = retained?.value();
        // Membership changes retain the incumbent selector's surviving rows.
        // A different selector or Account never receives another one's T values.
        let value: ReadonlyMap<string, T | MachineAgentsSnapshot> = new Map(machineIds.flatMap(id =>
            previousValue?.has(id) ? [[id, previousValue.get(id)!] as const] : []));
        const inputs = new Map(machineIds.flatMap(id => {
            const input = retained?.inputs.get(id);
            return input ? [[id, input] as const] : [];
        }));
        let observed = 0;
        let current = lifetime?.isCurrent() === true;
        let facts: typeof machineFacts | undefined;
        const update = (ids: readonly string[]) => {
            let next: Map<string, T | MachineAgentsSnapshot> | undefined;
            for (const id of ids) {
                const snapshot = lifetime?.isCurrent() ? readMachineAgentsForScope(lifetime, id) : EMPTY_MACHINE_AGENTS;
                let online = id === alwaysOnlineMachineId;
                if (select && !online) {
                    // A keyed inventory publication can precede React's presence
                    // render. Resolve only its Machine through the existing owner.
                    const machine = lifetime?.isCurrent()
                        ? resolveServerScopedMachine(getStorage().getState(), lifetime.scope.serverId, id) : null;
                    online = Boolean(machine && lifetime && isMachineSelectableForFleet(lifetime.scope, machine));
                }
                const previous = inputs.get(id);
                if (previous?.snapshot === snapshot && previous.online === online) continue;
                inputs.set(id, { snapshot, online });
                const selected = select ? select(snapshot, value.get(id) as T | undefined, online) : snapshot;
                if (value.has(id) && value.get(id) === selected) continue;
                next ??= new Map(value);
                next.set(id, selected);
            }
            if (next) value = next;
            return next !== undefined;
        };
        const read = (nextFacts: typeof machineFacts) => {
            const nextCurrent = lifetime?.isCurrent() === true;
            if (observed === 0 || current !== nextCurrent) update(machineIds);
            else if (select && facts !== nextFacts) {
                const changed = machineIds.filter((id, index) =>
                    inputs.get(id)?.online !== (id === alwaysOnlineMachineId || nextFacts[index]?.online === true));
                update(changed);
            }
            current = nextCurrent;
            facts = nextFacts;
            return value;
        };
        const subscribe = (listener: () => void) => {
            const disposers = lifetime ? machineIds.map(id => machineAgentInventoryStore.subscribe(scopeKey(lifetime, id), () => {
                if (update([id])) listener();
            })) : [];
            observed += 1;
            // Catch publications between render and subscription, including a
            // newly selected membership/selector or Account lifetime.
            if (update(machineIds)) listener();
            return () => { observed -= 1; for (const dispose of disposers) dispose(); };
        };
        published.current = { lifetime, select, alwaysOnlineMachineId, inputs, value: () => value };
        return { read, subscribe };
    }, [alwaysOnlineMachineId, lifetime, machineIds, select]);
    const readSummary = React.useCallback(() => summary.read(machineFacts), [machineFacts, summary]);
    const readAcp = React.useCallback(() => lifetime ? getAcpCatalogSnapshot(lifetime.scope) : null, [lifetime]);
    const acpCatalog = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
    // These are the mounted observation's inputs, not a second inventory. Global
    // Account/auth/catalog changes renew all entries; keyed facts renew one.
    const observations = React.useMemo(() => new Map<string, Readonly<{
        fact: typeof machineFacts[number]; reader: typeof projectionReaders[number];
        revision: number; projection: ReturnType<typeof projectionReaders[number]['readCached']>;
    }>>(), [acpCatalog, authentication, lifetime]);
    const acquisitions = React.useMemo(() => new Map<string, Readonly<{
        online: boolean; revision: number; abort: AbortController;
    }>>(), [lifetime, presented, target.load, target.serverId]);
    React.useEffect(() => () => {
        for (const acquisition of acquisitions.values()) acquisition.abort.abort();
        acquisitions.clear();
    }, [acquisitions]);
    React.useEffect(() => {
        if (!presented || !lifetime || target.load !== true) return;
        for (const [index, machineId] of machineIds.entries()) {
            const online = machineFacts[index]?.online === true;
            const revision = projectionReaders[index]!.readRevision();
            const previous = acquisitions.get(machineId);
            if (previous?.online === online && previous.revision === revision) continue;
            previous?.abort.abort();
            const abort = new AbortController();
            acquisitions.set(machineId, { online, revision, abort });
            void refreshMachineAgents({ serverId: lifetime.scope.serverId, machineId, accountLifetime: lifetime, signal: abort.signal });
        }
        const currentIds = new Set(machineIds);
        for (const [id, acquisition] of acquisitions) if (!currentIds.has(id)) {
            acquisition.abort.abort();
            acquisitions.delete(id);
        }
    }, [acquisitions, lifetime, machineFacts, machineIds, presented, projectionReaders, projectionRevisions, target.load]);
    React.useEffect(() => {
        if (!lifetime) return;
        for (const [index, machineId] of machineIds.entries()) {
            const reader = projectionReaders[index]!;
            const inputs = reader.readCached();
            const revision = reader.readRevision();
            const previous = observations.get(machineId);
            const fact = machineFacts[index]!;
            if (previous?.fact === fact && previous.reader === reader && previous.revision === revision && previous.projection === inputs) continue;
            observations.set(machineId, { fact, reader, revision, projection: inputs });
            if (machineFacts[index]?.online !== true || inputs?.kind === 'ready' || inputs?.kind === 'error') {
                observe({ lifetime, machineId, authentication, revision,
                    projection: { phase: inputs?.kind === 'ready' || inputs?.kind === 'error' ? inputs.kind : 'idle',
                        inputs: inputs?.kind === 'ready' || inputs?.kind === 'error' ? inputs.inputs ?? null : null } });
            }
        }
        const currentIds = new Set(machineIds);
        for (const id of observations.keys()) if (!currentIds.has(id)) observations.delete(id);
    }, [authentication, lifetime, machineFacts, machineIds, observations, projectionReaders, projectionRevisions, reachabilityRevision, target.load, target.serverId]);
    return React.useSyncExternalStore(summary.subscribe, readSummary, readSummary);
}
