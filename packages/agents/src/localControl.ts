import type {
  AgentId,
  AgentLocalControlAttachStrategy,
  AgentLocalControlTopology,
} from './types.js';
import { localControlDeclarationHostsTerminal } from './definitions/agentCapabilityProjection.js';
import { getAgentCore } from './manifest.js';

export type AgentLocalControlCapability = Readonly<{
  supported: boolean;
  topology: AgentLocalControlTopology;
  attachStrategy: AgentLocalControlAttachStrategy;
  remoteWritable: boolean;
}>;

export function getAgentLocalControlCapability(agentId: AgentId): AgentLocalControlCapability | null {
  const localControl = getAgentCore(agentId)?.localControl;
  if (!localControl || localControl.supported !== true) return null;
  return {
    supported: true,
    topology: localControl.topology ?? 'exclusive',
    attachStrategy: localControl.attachStrategy ?? 'unsupported',
    remoteWritable: localControl.remoteWritable === true,
  };
}

export function usesProviderAttachForLocalControl(agentId: AgentId): boolean {
  return getAgentLocalControlCapability(agentId)?.attachStrategy === 'provider_attach';
}

/**
 * Reads the terminal-hosting rule from the one owner that a packaged Agent
 * manifest is also projected through, so this Agent-keyed answer and the
 * `terminal` capability surface it ships can never disagree.
 */
export function usesTerminalHostedLocalControl(agentId: AgentId): boolean {
  return localControlDeclarationHostsTerminal(getAgentCore(agentId)?.localControl);
}
