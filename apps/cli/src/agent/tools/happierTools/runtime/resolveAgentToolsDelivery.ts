import { getAgentToolsCapability, resolveAgentIdFromFlavor, type AgentId } from '@happier-dev/agents';

export type AgentToolsDeliveryRuntimeContext = Readonly<{
  platform?: NodeJS.Platform;
  environmentVariables?: Readonly<Record<string, string | undefined>>;
  directory?: string | null;
}>;

export type AgentToolsDeliveryAvailabilityResolver = (
  context: AgentToolsDeliveryRuntimeContext,
) => boolean;

export function resolveAgentToolsDelivery(
  agentId: AgentId | string,
  runtimeContext: AgentToolsDeliveryRuntimeContext = {},
  resolveRuntimeAvailability?: AgentToolsDeliveryAvailabilityResolver,
): 'native_mcp' | 'shell_bridge' | 'unsupported' {
  try {
    const resolvedAgentId = resolveAgentIdFromFlavor(agentId);
    if (!resolvedAgentId) return 'unsupported';
    const delivery = getAgentToolsCapability(resolvedAgentId).delivery;
    return delivery === 'shell_bridge'
      && resolveRuntimeAvailability
      && !resolveRuntimeAvailability(runtimeContext)
        ? 'unsupported'
        : delivery;
  } catch {
    return 'unsupported';
  }
}
