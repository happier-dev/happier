import { AGENTS_CORE } from './manifest.js';
import type {
  AgentCore,
  AgentId,
  AgentLocalControlAttachStrategy,
  AgentLocalControlTopology,
} from './types.js';

export type AgentLocalControlCapability = Readonly<{
  supported: boolean;
  topology: AgentLocalControlTopology;
  attachStrategy: AgentLocalControlAttachStrategy;
}>;

export function getAgentLocalControlCapability(agentId: AgentId): AgentLocalControlCapability | null {
  const agent = AGENTS_CORE[agentId] as AgentCore;
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
