import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

type PublishedMachineAgentInventory = MachinePublishedMetadataV1['agentInventory']
  | Pick<NonNullable<MachinePublishedMetadataV1['agentInventory']>, 'installedAgentIds'>;

/** Factory availability does not establish any of its configured executable instances. */
export function readInstalledMachineAgentInventory(
  published: PublishedMachineAgentInventory,
  cached: MachineAgentsSnapshot | undefined,
  definitionIds?: readonly string[],
): Readonly<{ agentIds: readonly string[]; complete: boolean }> {
  const ids = published?.installedAgentIds ?? (cached?.agents ?? [])
    .filter(agent => agent.installed).map(agent => agent.agentId);
  const requiresDefinition = (agentId: string) => !BackendTargetRefV2Schema.safeParse({ kind: 'backend', backendId: agentId }).success;
  const carriers = ids.filter(requiresDefinition);
  const configured = (cached?.agents ?? []).filter(agent => agent.definitionId !== undefined
    && definitionIds?.includes(agent.definitionId)
    && (!published || carriers.includes(agent.agentId)));
  const agentIds = [...new Set([
    ...ids.filter(agentId => !requiresDefinition(agentId)),
    ...configured.filter(agent => agent.installed).map(agent => agent.agentId),
  ])];
  const configuredKnown = carriers.length === 0 || definitionIds !== undefined && definitionIds.every(definitionId =>
    configured.some(agent => agent.definitionId === definitionId && !agent.unavailableReason));
  return {
    agentIds: published && agentIds.length === ids.length && agentIds.every((agentId, index) => agentId === ids[index]) ? ids : agentIds,
    complete: (published !== undefined || cached?.lastCheckedAt != null) && configuredKnown,
  };
}

/** Shared passive read for reach and Action facts; it never starts a probe. */
export function readInstalledMachineAgentIds(
  published: PublishedMachineAgentInventory,
  cached: MachineAgentsSnapshot | undefined,
  definitionIds?: readonly string[],
): readonly string[] {
  return readInstalledMachineAgentInventory(published, cached, definitionIds).agentIds;
}
