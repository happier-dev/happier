import { buildMachineAgentInventoryKey, type MachineAgentInventoryDescriptor, type MachineAgentInventoryItem, type MachineAgentInventoryUnavailable } from '@happier-dev/protocol/capabilities';
import type { MachineAgent, MachineAgentConnectedService } from './machineAgentTypes';
import { projectMachineAgent, reconcileMachineAgents, type MachineAgentCredentialSelection } from './machineAgentModel';
import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readInstalledMachineAgentInventory } from '@/sync/domains/capabilities/reach/installedMachineAgents';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';

export type MachineAgentsSnapshot = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'offline' | 'error';
    agents: readonly MachineAgent[];
    lastCheckedAt: number | null;
    /** Classified failure of the whole inventory read, including before any Agent row exists. */
    failure?: NonNullable<MachineAgent['unavailableReason']>;
}>;
export type MachineAgentInventoryObservation = Readonly<{
    status: MachineAgentsSnapshot['status'];
    items: readonly MachineAgentInventoryItem[];
    /** Machine-owned native installation facts arrive independently of requester probes. */
    installedAgentIds?: readonly string[];
    unavailable?: readonly MachineAgentInventoryUnavailable[];
    lastCheckedAt: number | null;
    failure?: MachineAgentsSnapshot['failure'];
    descriptors?: readonly MachineAgentInventoryDescriptor[];
    connectedServicesByAgentId?: Readonly<Record<string, readonly MachineAgentConnectedService[]>>;
    credentialSelectionsByAgentId?: Readonly<Record<string, MachineAgentCredentialSelection>>;
    jobsByAgentId?: Readonly<Record<string, MachineAgent['job']>>;
    dependencyTitlesByKey?: Readonly<Record<string, string>>;
}>;

export const EMPTY_MACHINE_AGENTS: MachineAgentsSnapshot = Object.freeze({ status: 'idle', agents: Object.freeze([]), lastCheckedAt: null });

export type HeldMachineAgentSummary = Readonly<{
    machineCount: number;
    versions: readonly string[];
    unknownVersionCount: number;
    complete: boolean;
}>;

export function createMachineAgentInventoryStore() {
    const snapshots = new Map<string, MachineAgentsSnapshot>();
    const listeners = new Map<string, Set<() => void>>();
    const agentListeners = new Map<string, Set<() => void>>();
    const factsByScope = new Map<string, Map<string, MachineAgentInventoryItem>>();
    const jobsByScope = new Map<string, Readonly<Record<string, MachineAgent['job']>>>();
    const credentialsByScope = new Map<string, NonNullable<MachineAgentInventoryObservation['credentialSelectionsByAgentId']>>();
    const project = (key: string, observation: MachineAgentInventoryObservation): MachineAgentsSnapshot => {
        const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
        const failure = observation.status === 'error' ? observation.failure ?? previous.failure
            : observation.status === 'loading' ? previous.failure : undefined;
        if (observation.jobsByAgentId) jobsByScope.set(key, observation.jobsByAgentId);
        const jobs = jobsByScope.get(key);
        if (observation.credentialSelectionsByAgentId) credentialsByScope.set(key, observation.credentialSelectionsByAgentId);
        const credentials = credentialsByScope.get(key);
        const factsById = factsByScope.get(key) ?? new Map<string, MachineAgentInventoryItem>();
        for (const item of observation.items) factsById.set(buildMachineAgentInventoryKey(item), item);
        factsByScope.set(key, factsById);
        const descriptors = [...(observation.descriptors ?? (observation.items.length > 0 ? observation.items : previous.agents))];
        const unavailableById = new Map(observation.unavailable?.map(({ agentId, definitionId, ...reason }) => [buildMachineAgentInventoryKey({ agentId, definitionId }), reason]));
        const refreshedIds = new Set(observation.items.map(buildMachineAgentInventoryKey));
        const previousById = new Map(previous.agents.map(agent => [buildMachineAgentInventoryKey(agent), agent]));
        const installedAgentIds = observation.installedAgentIds === undefined ? undefined
            : new Set(readInstalledMachineAgentInventory({ installedAgentIds: observation.installedAgentIds }, undefined).agentIds);
        // The same Machine-owned installation projection shown in Overview remains useful
        // before this Account has acquired a requester authentication probe or daemon catalog.
        const descriptorKeys = new Set(descriptors.map(buildMachineAgentInventoryKey));
        for (const agentId of installedAgentIds ?? []) {
            if (!descriptorKeys.has(buildMachineAgentInventoryKey({ agentId }))) {
                descriptors.push({ agentId, title: resolveAgentCatalogTitle(agentId) });
            }
        }
        const agents = reconcileMachineAgents(previous.agents, descriptors.map((descriptor) => {
            const previousAgent = previousById.get(buildMachineAgentInventoryKey(descriptor));
            let facts = factsById.get(buildMachineAgentInventoryKey(descriptor));
            // Shared Machine installation and requester authentication have separate producers.
            // A publication must also update retained facts while no probe snapshot is acquired.
            if (facts && descriptor.definitionId === undefined && installedAgentIds !== undefined) {
                const installed = installedAgentIds.has(descriptor.agentId);
                if (facts.installed !== installed) {
                    facts = { ...facts, installed };
                    factsById.set(buildMachineAgentInventoryKey(descriptor), facts);
                }
            }
            const credentialSelection: MachineAgentCredentialSelection = credentials?.[descriptor.agentId] ?? { credentialBindings: null };
            const projected = projectMachineAgent({
                ...descriptor,
                facts: facts ?? null,
                installed: descriptor.definitionId === undefined
                    ? installedAgentIds?.has(descriptor.agentId) ?? facts?.installed ?? previousAgent?.installed
                    : undefined,
                checking: observation.status === 'loading',
                // Starting or deferring a read does not make retained/offline facts fresh. Only its settled
                // observation can promote them; already-current rows remain current on refresh.
                stale: observation.status === 'offline' || observation.status === 'error'
                    || observation.status !== 'ready' && previousAgent?.stale === true,
                staleReason: observation.status === 'offline' ? 'offline' : observation.status === 'error' ? 'error'
                    : observation.status !== 'ready' ? previousAgent?.staleReason : undefined,
                unavailableReason: unavailableById.get(buildMachineAgentInventoryKey(descriptor))
                    ?? (observation.status === 'error' ? failure : undefined)
                    ?? (refreshedIds.has(buildMachineAgentInventoryKey(descriptor)) ? undefined : previousAgent?.unavailableReason),
                connectedServices: observation.connectedServicesByAgentId?.[descriptor.agentId] ?? previousAgent?.signIn.connectedServices ?? [],
                credentialSelection,
                job: jobs ? jobs[buildMachineAgentInventoryKey(descriptor)] ?? null : previousAgent?.job ?? null,
                dependencyTitlesByKey: observation.dependencyTitlesByKey,
            });
            // Hydrated native sign-in evidence reserves a pending row, but cannot assert Account-effective trouble.
            // Keep its non-ready pending state until the first credential choice is read; publishing unknown here
            // withdraws it before verification. Authentication facts, installation changes and failures still settle.
            if (previousAgent?.state === 'needsSignIn' && !previousAgent.signInTrouble
                && credentialSelection.credentialBindingsReady === false && projected.state === 'unknown'
                && !projected.unavailableReason) {
                return { ...projected, state: previousAgent.state };
            }
            // Attention is last verified display evidence, separate from current execution readiness.
            // An unread credential choice or failed refresh cannot prove that sign-in was repaired.
            const verified = observation.status === 'ready' && projected.state !== 'unknown' && projected.state !== 'checking';
            const signInTrouble = verified ? projected.state === 'needsSignIn' : previousAgent?.signInTrouble === true;
            return signInTrouble ? { ...projected, signInTrouble: true as const } : projected;
        }));
        const lastCheckedAt = observation.lastCheckedAt ?? previous.lastCheckedAt;
        const sameFailure = failure?.reason === previous.failure?.reason && failure?.errorCode === previous.failure?.errorCode;
        return agents === previous.agents && observation.status === previous.status && lastCheckedAt === previous.lastCheckedAt && sameFailure
            ? previous : { status: observation.status, agents, lastCheckedAt, ...(failure ? { failure } : {}) };
    };
    return {
        read(key: string, initialize?: () => MachineAgentInventoryObservation | null): MachineAgentsSnapshot {
            if (!snapshots.has(key) && initialize) {
                const saved = initialize();
                // First-read hydration belongs to this snapshot, not a render publication. Remember an empty
                // read in the same map too, so remounting does not read persistence again.
                snapshots.set(key, saved ? project(key, saved) : EMPTY_MACHINE_AGENTS);
            }
            return snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
        },
        /** A mounted summary observes only held installation/version facts; it never acquires inventory. */
        createHeldAgentSummary(keys: readonly string[], agentId: string, definitionId?: string,
            publishedByKey?: ReadonlyMap<string, MachinePublishedMetadataV1['agentInventory']>) {
            const inventoryKeys = [...new Set(keys)];
            type Fact = Readonly<{ installed: boolean; version: string | null; complete: boolean }>;
            const facts = new Map<string, Fact>();
            const versions = new Map<string, number>();
            let machineCount = 0;
            let unknownVersionCount = 0;
            let unknownMachineCount = 0;
            let snapshot: HeldMachineAgentSummary = { machineCount: 0, versions: [], unknownVersionCount: 0, complete: false };
            const listeners = new Set<() => void>();
            let disposers: Array<() => void> = [];
            const adjust = (fact: Fact | undefined, delta: number) => {
                if (fact === undefined) return;
                if (!fact.complete) unknownMachineCount += delta;
                if (!fact.installed) return;
                const version = fact.version;
                machineCount += delta;
                if (version === null) unknownVersionCount += delta;
                else {
                    const count = (versions.get(version) ?? 0) + delta;
                    if (count === 0) versions.delete(version);
                    else versions.set(version, count);
                }
            };
            const update = (key: string) => {
                const cached = this.read(key);
                // This summary asks about one Agent, not all configured instances on the Machine.
                const inventory = readInstalledMachineAgentInventory(publishedByKey?.get(key), cached, definitionId ? [definitionId] : []);
                const agent = cached.agents.find(row => row.agentId === agentId && row.definitionId === definitionId);
                const installed = inventory.agentIds.includes(agentId) && (definitionId === undefined || agent?.installed === true);
                const fact = { installed, version: installed && agent?.installed ? agent.version : null, complete: inventory.complete };
                const previous = facts.get(key);
                if (previous?.installed === fact.installed && previous.version === fact.version && previous.complete === fact.complete) return false;
                adjust(previous, -1);
                facts.set(key, fact);
                adjust(fact, 1);
                return true;
            };
            const publish = () => {
                const nextVersions = [...versions.keys()].sort();
                const complete = inventoryKeys.length > 0 && unknownMachineCount === 0;
                if (snapshot.machineCount === machineCount && snapshot.unknownVersionCount === unknownVersionCount
                    && snapshot.complete === complete
                    && snapshot.versions.length === nextVersions.length && snapshot.versions.every((v, i) => v === nextVersions[i])) return;
                snapshot = { machineCount, versions: nextVersions, unknownVersionCount, complete };
                for (const listener of listeners) listener();
            };
            const refresh = () => { for (const key of inventoryKeys) update(key); publish(); };
            refresh();
            return {
                getSnapshot: () => { if (listeners.size === 0) refresh(); return snapshot; },
                subscribe: (listener: () => void) => {
                    if (listeners.size === 0) {
                        disposers = inventoryKeys.map(key => this.subscribe(key, () => {
                            if (update(key)) publish();
                        }));
                        refresh();
                    }
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                        if (listeners.size === 0) { for (const off of disposers) off(); disposers = []; }
                    };
                },
            };
        },
        subscribe(key: string, listener: () => void) {
            const subscribers = listeners.get(key) ?? new Set();
            subscribers.add(listener); listeners.set(key, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
        },
        subscribeAgent(key: string, agentId: string, listener: () => void, definitionId?: string) {
            const agentKey = JSON.stringify([key, buildMachineAgentInventoryKey({ agentId, definitionId })]);
            const subscribers = agentListeners.get(agentKey) ?? new Set();
            subscribers.add(listener); agentListeners.set(agentKey, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) agentListeners.delete(agentKey); };
        },
        /** After publication, persist only this observation's successful rows with their effective installation facts. */
        readObservedItems(key: string, items: readonly MachineAgentInventoryItem[]): readonly MachineAgentInventoryItem[] {
            return items.map(item => factsByScope.get(key)!.get(buildMachineAgentInventoryKey(item))!);
        },
        publish(key: string, observation: MachineAgentInventoryObservation): void {
            const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
            const snapshot = project(key, observation);
            if (snapshot === previous) return;
            snapshots.set(key, snapshot);
            for (const listener of listeners.get(key) ?? []) listener();
            const prior = new Map(previous.agents.map((agent) => [buildMachineAgentInventoryKey(agent), agent]));
            const next = new Map(snapshot.agents.map((agent) => [buildMachineAgentInventoryKey(agent), agent]));
            for (const agentId of new Set([...prior.keys(), ...next.keys()])) {
                if (prior.get(agentId) === next.get(agentId)) continue;
                for (const listener of agentListeners.get(JSON.stringify([key, agentId])) ?? []) listener();
            }
        },
        publishJobs(key: string, jobs: ReadonlyMap<string, NonNullable<MachineAgent['job']>>): void {
            const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
            this.publish(key, { status: previous.status, items: [], lastCheckedAt: previous.lastCheckedAt, jobsByAgentId: Object.fromEntries(jobs),
                dependencyTitlesByKey: Object.fromEntries(previous.agents.flatMap((agent) => agent.dependencies.map((dependency) => [dependency.key, dependency.title]))),
            });
        },
    };
}

export const machineAgentInventoryStore = createMachineAgentInventoryStore();
