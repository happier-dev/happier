import type { AgentCore, AgentId } from '../types.js';
import { getAgentCore } from '../manifest.js';

export function isConcreteBackendDefinitionAgentId(agentId: AgentId): boolean {
  return (getAgentCore(agentId) as AgentCore).backendDefinition !== false;
}

export function resolveOwnedBackendIdsForAgent(agentId: AgentId): readonly AgentId[] {
  return isConcreteBackendDefinitionAgentId(agentId) ? [agentId] : [];
}
