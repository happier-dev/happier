import { getAgentToolsCapability, resolveAgentIdFromFlavor, type AgentId } from '@happier-dev/agents';

export function resolveAgentToolsDelivery(agentId: AgentId | string): 'native_mcp' | 'shell_bridge' | 'unsupported' {
  try {
    const resolvedAgentId = resolveAgentIdFromFlavor(agentId);
    if (!resolvedAgentId) return 'unsupported';
    return getAgentToolsCapability(resolvedAgentId).delivery;
  } catch {
    return 'unsupported';
  }
}
