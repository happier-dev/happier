import { buildMachineAgentInventoryKey, projectMachineAgentsDetectResponse, type MachineAgentInventoryDescriptor, type MachineAgentInventoryItem, type MachinesAgentsListOutput } from '@happier-dev/protocol/capabilities';
import type { MachineCapabilitiesCacheState } from '@/hooks/server/useMachineCapabilitiesCache';
import type { MachineAgentInventoryObservation } from './machineAgentInventoryStore';

export function projectMachineAgentCapabilityObservation(
    agents: readonly MachineAgentInventoryDescriptor[],
    cache: MachineCapabilitiesCacheState | null,
    previousFacts: readonly Pick<MachineAgentInventoryItem, 'agentId' | 'definitionId' | 'latestVersion'>[] = [],
    definitionInventory: Pick<Parameters<typeof projectMachineAgentsDetectResponse>[0], 'definitions' | 'definitionCatalog'> = {},
): MachineAgentInventoryObservation {
    const snapshot = cache && 'snapshot' in cache ? cache.snapshot : undefined;
    let inventory: MachinesAgentsListOutput = { items: [] };
    let invalidResponse = false;
    let lastCheckedAt: number | null = null;
    const memberInstalledCheckedAtByKey = new Map<string, number>();
    if (snapshot) {
        try {
            inventory = projectMachineAgentsDetectResponse({ agents, response: snapshot.response, ...definitionInventory });
            const previousLatestVersions = new Map(previousFacts.map(item => [buildMachineAgentInventoryKey(item), item.latestVersion]));
            inventory.items = inventory.items.map(item => {
                const result = snapshot.response.results[`cli.${item.agentId}`];
                if (item.install.executionScope === 'member') {
                    const check = item.definitionId === undefined ? result : snapshot.response.results['tool.acpAgentInventory'];
                    if (check?.ok) memberInstalledCheckedAtByKey.set(buildMachineAgentInventoryKey(item), check.checkedAt);
                }
                const data = result?.ok ? result.data : null;
                const latestVersion = previousLatestVersions.get(buildMachineAgentInventoryKey(item));
                // An unrequested update fact does not withdraw a known version.
                // Explicit null and every authentication fact remain authoritative.
                return item.definitionId === undefined && latestVersion != null && data !== null && typeof data === 'object'
                    && !Object.prototype.hasOwnProperty.call(data, 'latestVersion')
                    ? { ...item, latestVersion } : item;
            });
            for (const agent of agents) {
                const checkedAt = snapshot.response.results[`cli.${agent.agentId}`]?.checkedAt;
                if (typeof checkedAt === 'number') lastCheckedAt = Math.max(lastCheckedAt ?? 0, checkedAt);
            }
            const definitionsCheckedAt = snapshot.response.results['tool.acpAgentInventory']?.checkedAt;
            if (definitionInventory.definitions && typeof definitionsCheckedAt === 'number') lastCheckedAt = Math.max(lastCheckedAt ?? 0, definitionsCheckedAt);
        } catch { invalidResponse = true; }
    }
    const status = !cache || cache.status === 'idle'
        ? 'idle'
        : cache.status === 'loading' ? 'loading'
        : cache.status === 'loaded' && !invalidResponse ? 'ready' : 'error';
    const failure = cache?.status === 'error'
        ? { reason: 'probe_failed' as const, ...(cache.error?.rpcErrorCode ? { errorCode: cache.error.rpcErrorCode } : {}) }
        : undefined;
    return { status, ...inventory, descriptors: agents, lastCheckedAt,
        ...(memberInstalledCheckedAtByKey.size > 0 ? { memberInstalledCheckedAtByKey } : {}),
        ...(failure ? { failure, unavailable: agents.map(({ agentId, definitionId }) => ({ agentId,
            ...(definitionId === undefined ? {} : { definitionId }), ...failure })) } : {}) };
}
