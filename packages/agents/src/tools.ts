import type { AgentId, AgentToolsDelivery, AgentToolsSupportLevel, BundledAgentId } from './types.js';
import { getAgentCore } from './manifest.js';

export type AgentToolsCapability = Readonly<{
  delivery: AgentToolsDelivery;
  support: AgentToolsSupportLevel;
}>;

export function getAgentToolsCapability(agentId: BundledAgentId): AgentToolsCapability;
export function getAgentToolsCapability(agentId: AgentId): AgentToolsCapability | null;
export function getAgentToolsCapability(agentId: AgentId): AgentToolsCapability | null {
  return getAgentCore(agentId)?.tools ?? null;
}

export function usesNativeMcpTools(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId)?.delivery === 'native_mcp';
}

export function usesNativeExtensionTools(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId)?.delivery === 'native_extension';
}

export function usesShellBridgeTools(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId)?.delivery === 'shell_bridge';
}

export function isAgentToolsUnsupported(agentId: AgentId): boolean {
  return getAgentToolsCapability(agentId)?.delivery === 'unsupported';
}
