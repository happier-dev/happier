import type { AgentsBackendsListOutput } from '@happier-dev/protocol/actions/agentBackendInventory';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { resolvePreferredBackendTarget } from '@/agents/backendCatalog/resolvePreferredBackendTarget';
import { readMachineAgentsForScope } from '@/agents/machineAgents/useMachineAgents';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type VoiceSpawnAlternative = Readonly<{
  targetKey: string;
  label: string;
  agentTarget: AgentExecutionTargetV1;
}>;

/** An offer, never a replacement launch or a new readiness probe. */
export function resolveVoiceSpawnAlternative(params: Readonly<{
  inventory: AgentsBackendsListOutput;
  selectedTarget: AgentExecutionTargetV1;
  lifetime: ServerAccountScopeLifetime;
  machineId: string;
}>): VoiceSpawnAlternative | undefined {
  const selectedKey = buildBackendTargetKeyV2(params.selectedTarget);
  const candidates = params.inventory.items.flatMap(item => {
    const agentTarget = item.agentTarget;
    if (!item.enabled || !agentTarget || item.targetKey === selectedKey) return [];
    return [{ targetKey: item.targetKey, label: item.label, agentTarget }];
  });
  if (candidates.length === 0) return undefined;
  const preferred = resolvePreferredBackendTarget({
    lastUsedAgent: null, availableBackendTargets: candidates.map(item => item.agentTarget),
    machineAgents: readMachineAgentsForScope(params.lifetime, params.machineId).agents,
  });
  if (!preferred) return undefined;
  const preferredKey = buildBackendTargetKeyV2(preferred);
  return candidates.find(item => item.targetKey === preferredKey);
}
