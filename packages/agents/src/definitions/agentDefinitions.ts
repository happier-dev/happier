import type { AgentId } from '../types.js';
import { AGENT_ARTIFACTS } from './buildAgentArtifacts.js';
import type { AgentCatalogDefinition } from './types.js';

export function getAllAgentCatalogDefinitions(): readonly AgentCatalogDefinition[] {
  return AGENT_ARTIFACTS.agentDefinitions;
}

export function getAgentCatalogDefinition(agentId: AgentId): AgentCatalogDefinition | null {
  return AGENT_ARTIFACTS.agentDefinitionsById.get(agentId) ?? null;
}

export function getAllAgentDefinitionContracts() {
  return AGENT_ARTIFACTS.agentDefinitionContracts;
}

export function getAgentDefinitionContract(agentId: AgentId) {
  return AGENT_ARTIFACTS.agentDefinitionContractsById.get(agentId) ?? null;
}
