import { projectMachineAgentsDetectResponse, type MachineAgentInventoryDescriptor, type MachinesAgentsListOutput } from '@happier-dev/protocol/capabilities';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { MachineAgentInventoryObservation } from './machineAgentInventoryStore';

export function projectMachineAgentCapabilityObservation(agents: readonly MachineAgentInventoryDescriptor[], cache: MachineCapabilitiesCacheState | null): MachineAgentInventoryObservation {
    const snapshot = cache && 'snapshot' in cache ? cache.snapshot : undefined;
    let inventory: MachinesAgentsListOutput = { items: [] };
    let invalidResponse = false;
    let lastCheckedAt: number | null = null;
    if (snapshot) {
        try {
            inventory = projectMachineAgentsDetectResponse({ agents, response: snapshot.response });
            for (const agent of agents) {
                const checkedAt = snapshot.response.results[`cli.${agent.agentId}`]?.checkedAt;
                if (typeof checkedAt === 'number') lastCheckedAt = Math.max(lastCheckedAt ?? 0, checkedAt);
            }
        } catch { invalidResponse = true; }
    }
    const status = !cache || cache.status === 'idle' || cache.status === 'loading'
        ? 'loading'
        : cache.status === 'loaded' && !invalidResponse ? 'ready' : 'error';
    return { status, ...inventory, descriptors: agents, lastCheckedAt };
}
