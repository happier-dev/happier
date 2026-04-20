import type {
  AgentCore,
  AgentId,
  AgentLocalControlAttachStrategy,
  AgentLocalControlTopology,
} from './types.js';
import { getAgentCore } from './manifest.js';

export type AgentLocalControlCapability = Readonly<{
  supported: boolean;
  topology: AgentLocalControlTopology;
  attachStrategy: AgentLocalControlAttachStrategy;
}>;

export function getAgentLocalControlCapability(agentId: AgentId): AgentLocalControlCapability | null {
  const agent = getAgentCore(agentId) as AgentCore;
  const localControl = agent.localControl;
  if (!localControl || localControl.supported !== true) return null;
  return {
    supported: true,
    topology: localControl.topology ?? 'exclusive',
    attachStrategy: localControl.attachStrategy ?? 'unsupported',
  };
}

export function usesProviderAttachForLocalControl(agentId: AgentId): boolean {
  return getAgentLocalControlCapability(agentId)?.attachStrategy === 'provider_attach';
}

export function usesTerminalHostedLocalControl(agentId: AgentId): boolean {
  return getAgentLocalControlCapability(agentId)?.attachStrategy === 'terminal_host';
}
