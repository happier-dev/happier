import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { DetectCliSnapshot } from './cliSnapshot';

type MachineAgentInventory = NonNullable<MachinePublishedMetadataV1['agentInventory']>;
export type MachineAgentInventoryObservation = Readonly<{
  snapshot: DetectCliSnapshot;
  checkedAt: number;
  observedAgentIds?: readonly string[];
}>;

function retainInstalledAgentFacts(current: MachineAgentInventory | undefined, next: MachineAgentInventory): MachineAgentInventory {
  return current && current.installedAgentIds.length === next.installedAgentIds.length
    && current.installedAgentIds.every((agentId, index) => agentId === next.installedAgentIds[index]) ? current : next;
}

/** Project the existing detector's facts without publishing paths, dependencies or authentication. */
export function projectMachineAgentInventoryFromCliSnapshot(input: MachineAgentInventoryObservation & Readonly<{
  current?: MachinePublishedMetadataV1['agentInventory'];
}>): MachineAgentInventory {
  const previous = new Set(input.current?.installedAgentIds ?? []);
  // Failed census reads cannot establish that omitted catalog members were removed.
  const partial = input.observedAgentIds !== undefined || Object.values(input.snapshot.clis).some(fact => fact.detectionError);
  const installed = new Set(partial ? previous : []);
  for (const agentId of input.observedAgentIds ?? Object.keys(input.snapshot.clis)) {
    const fact = input.snapshot.clis[agentId];
    if (!fact || fact.detectionError || fact.installed === undefined) {
      if (previous.has(agentId)) installed.add(agentId);
    } else if (fact.installed === true) installed.add(agentId);
    else installed.delete(agentId);
  }
  return retainInstalledAgentFacts(input.current, { checkedAt: input.checkedAt, installedAgentIds: [...installed].sort() });
}

/** The Machine publisher retains probe ordering, while Sync carries only changed install facts. */
export function createMachineAgentInventoryPublication() {
  let observed: MachineAgentInventory | undefined;
  return (observation: MachineAgentInventoryObservation, published?: MachineAgentInventory): MachineAgentInventory | undefined => {
    if (!observed || published && published.checkedAt > observed.checkedAt) observed = published;
    if (observed && observation.checkedAt < observed.checkedAt) return published;
    const next = projectMachineAgentInventoryFromCliSnapshot({ ...observation, current: observed });
    // Newer equal/partial probes still supersede older contradictory results,
    // including while a previous metadata CAS has not acknowledged its facts.
    observed = next.checkedAt === observation.checkedAt ? next : { ...next, checkedAt: observation.checkedAt };
    return retainInstalledAgentFacts(published, observed);
  };
}
