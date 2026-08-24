import { getAgentToolsCapability, resolveCanonicalAgentIdFromFlavor, type AgentId } from '@happier-dev/agents';

export function resolveAgentToolsDelivery(agentId: AgentId | string): 'native_mcp' | 'native_extension' | 'shell_bridge' | 'unsupported' {
  try {
    const resolvedAgentId = resolveCanonicalAgentIdFromFlavor(agentId);
    if (!resolvedAgentId) return 'unsupported';
    return getAgentToolsCapability(resolvedAgentId).delivery;
  } catch {
    return 'unsupported';
  }
}
