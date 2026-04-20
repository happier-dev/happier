import type { AgentId, AgentToolsDelivery, AgentToolsSupportLevel } from './types.js';
import { getAgentCore } from './manifest.js';

export type AgentToolsCapability = Readonly<{
  delivery: AgentToolsDelivery;
  support: AgentToolsSupportLevel;
}>;

export function getAgentToolsCapability(agentId: AgentId): AgentToolsCapability {
  return getAgentCore(agentId).tools;
}

export function usesNativeMcpTools(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId).delivery === 'native_mcp';
}

export function usesShellBridgeTools(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId).delivery === 'shell_bridge';
}

export function isAgentToolsUnsupported(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId).delivery === 'unsupported';
}
