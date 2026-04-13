import type { AgentCore, AgentId } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';

export function isConcreteBackendDefinitionAgentId(agentId: AgentId): boolean {
  return (AGENTS_CORE[agentId] as AgentCore).backendDefinition !== false;
}

export function resolveOwnedBackendIdsForAgent(agentId: AgentId): readonly AgentId[] {
  return isConcreteBackendDefinitionAgentId(agentId) ? [agentId] : [];
}
