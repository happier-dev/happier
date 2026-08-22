import type { AgentId } from '../types.js';
import { getAgentCore } from '../manifest.js';

/**
 * Whether `agentId` is a bundled Agent that contributes a concrete backend
 * definition. A non-bundled Agent contributes none through this owner.
 */
export function isConcreteBackendDefinitionAgentId(agentId: AgentId): boolean {
  const core = getAgentCore(agentId);
  return core != null && core.backendDefinition !== false;
}

export function resolveOwnedBackendIdsForAgent(agentId: AgentId): readonly AgentId[] {
  return isConcreteBackendDefinitionAgentId(agentId) ? [agentId] : [];
}
