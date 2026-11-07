import { AGENT_IDS, type AgentId, type BundledAgentId } from '../types.js';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '../generated/agentIds.js';
import { listAgentExecutionTargetsV1, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { AGENT_ARTIFACTS } from './buildAgentArtifacts.js';
import type { AgentCatalogDefinition } from './types.js';

export function getAllAgentCatalogDefinitions(): readonly AgentCatalogDefinition[] {
  return AGENT_ARTIFACTS.agentDefinitions;
}

export function getAgentCatalogDefinition(agentId: AgentId): AgentCatalogDefinition | null {
  return AGENT_ARTIFACTS.agentDefinitionsById.get(agentId) ?? null;
}

/** Preference choices come from bundled declarations, independently of execution-machine readiness. */
export function listSelectableBundledAgentExecutionTargets(): readonly Readonly<{
  agentId: BundledAgentId; target: AgentExecutionTargetV1;
}>[] {
  return AGENT_IDS.flatMap(agentId => {
    const definition = getAgentCatalogDefinition(agentId);
    if (!definition || definition.modelConfig?.supportsSelection === false) return [];
    return listAgentExecutionTargetsV1(BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId])
      .map(target => ({ agentId, target }));
  });
}

export function getAllAgentDefinitionContracts() {
  return AGENT_ARTIFACTS.agentDefinitionContracts;
}

export function getAgentDefinitionContract(agentId: AgentId) {
  return AGENT_ARTIFACTS.agentDefinitionContractsById.get(agentId) ?? null;
}
