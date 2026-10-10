import type { MachineAgentInventoryDescriptor, MachineAgentInventoryItem, MachineAgentInventoryUnavailable } from '@happier-dev/protocol/capabilities';
import type { MachineAgent, MachineAgentConnectedService } from './machineAgentTypes';
import { projectMachineAgent, reconcileMachineAgents } from './machineAgentModel';

export type MachineAgentsSnapshot = Readonly<{
    status: 'loading' | 'ready' | 'offline' | 'error';
    agents: readonly MachineAgent[];
    lastCheckedAt: number | null;
}>;
export type MachineAgentInventoryObservation = Readonly<{
    status: MachineAgentsSnapshot['status'];
    items: readonly MachineAgentInventoryItem[];
    unavailable?: readonly MachineAgentInventoryUnavailable[];
    lastCheckedAt: number | null;
    descriptors?: readonly MachineAgentInventoryDescriptor[];
    connectedServicesByAgentId?: Readonly<Record<string, readonly MachineAgentConnectedService[]>>;
    jobsByAgentId?: Readonly<Record<string, MachineAgent['job']>>;
    dependencyTitlesByKey?: Readonly<Record<string, string>>;
}>;

export const EMPTY_MACHINE_AGENTS: MachineAgentsSnapshot = Object.freeze({ status: 'loading', agents: Object.freeze([]), lastCheckedAt: null });

export function createMachineAgentInventoryStore() {
    const snapshots = new Map<string, MachineAgentsSnapshot>();
    const listeners = new Map<string, Set<() => void>>();
    const agentListeners = new Map<string, Set<() => void>>();
    const factsByScope = new Map<string, Map<string, MachineAgentInventoryItem>>();
    const jobsByScope = new Map<string, Readonly<Record<string, MachineAgent['job']>>>();
    return {
        read(key: string): MachineAgentsSnapshot { return snapshots.get(key) ?? EMPTY_MACHINE_AGENTS; },
        subscribe(key: string, listener: () => void) {
            const subscribers = listeners.get(key) ?? new Set();
            subscribers.add(listener); listeners.set(key, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
        },
        subscribeAgent(key: string, agentId: string, listener: () => void) {
            const agentKey = JSON.stringify([key, agentId]);
            const subscribers = agentListeners.get(agentKey) ?? new Set();
            subscribers.add(listener); agentListeners.set(agentKey, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) agentListeners.delete(agentKey); };
        },
        publish(key: string, observation: MachineAgentInventoryObservation): void {
            const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
            if (observation.jobsByAgentId) jobsByScope.set(key, observation.jobsByAgentId);
            const jobs = jobsByScope.get(key);
            const factsById = factsByScope.get(key) ?? new Map<string, MachineAgentInventoryItem>();
            for (const item of observation.items) factsById.set(item.agentId, item);
            factsByScope.set(key, factsById);
            const descriptors = observation.descriptors ?? (observation.items.length > 0 ? observation.items : previous.agents);
            const unavailableById = new Map(observation.unavailable?.map(({ agentId, ...reason }) => [agentId, reason]));
            const refreshedIds = new Set(observation.items.map((item) => item.agentId));
            const agents = reconcileMachineAgents(previous.agents, descriptors.map((descriptor) => projectMachineAgent({
                ...descriptor,
                facts: factsById.get(descriptor.agentId) ?? null,
                checking: observation.status === 'loading',
                stale: observation.status === 'offline' || observation.status === 'error',
                unavailableReason: unavailableById.get(descriptor.agentId)
                    ?? (refreshedIds.has(descriptor.agentId) ? undefined : previous.agents.find((agent) => agent.agentId === descriptor.agentId)?.unavailableReason),
                connectedServices: observation.connectedServicesByAgentId?.[descriptor.agentId] ?? previous.agents.find((agent) => agent.agentId === descriptor.agentId)?.signIn.connectedServices ?? [],
                job: jobs ? jobs[descriptor.agentId] ?? null : previous.agents.find((agent) => agent.agentId === descriptor.agentId)?.job ?? null,
                dependencyTitlesByKey: observation.dependencyTitlesByKey,
            })));
            const lastCheckedAt = observation.lastCheckedAt ?? previous.lastCheckedAt;
            if (agents === previous.agents && observation.status === previous.status && lastCheckedAt === previous.lastCheckedAt) return;
            snapshots.set(key, { status: observation.status, agents, lastCheckedAt });
            for (const listener of listeners.get(key) ?? []) listener();
            const prior = new Map(previous.agents.map((agent) => [agent.agentId, agent]));
            const next = new Map(agents.map((agent) => [agent.agentId, agent]));
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
