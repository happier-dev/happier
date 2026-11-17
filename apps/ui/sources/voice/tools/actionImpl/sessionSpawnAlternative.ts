import type { SessionSpawnNewActionAuthoringInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
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

/** Offer diagnostics for the authored or creation-owner-prepared choice without resolving defaults. */
export async function readVoiceSpawnAlternative(input: Pick<SessionSpawnNewActionAuthoringInputV2, 'agentTarget' | 'executionTarget'>,
  execute: FrontDoorActionExecute, signal?: AbortSignal,
): Promise<VoiceSpawnAlternative | undefined> {
  if (!input.agentTarget || !input.executionTarget) return undefined;
  try {
    const scope = await resolveServerCredentialAccountScope(input.executionTarget.serverId);
    if (scope.kind !== 'bound') return undefined;
    const lifetime = captureServerCredentialAccountScopeLifetime(scope);
    const listed = await execute('agents.backends.list', { machineId: input.executionTarget.machineId }, {
      surface: 'voice', serverId: input.executionTarget.serverId, ...(signal ? { signal } : {}),
    });
    if (!listed.ok || !lifetime.isCurrent()) return undefined;
    return resolveVoiceSpawnAlternative({ inventory: listed.result as AgentsBackendsListOutput,
      selectedTarget: input.agentTarget, lifetime, machineId: input.executionTarget.machineId });
  } catch {
    // An optional recovery offer cannot replace the canonical creation failure.
    return undefined;
  }
}
