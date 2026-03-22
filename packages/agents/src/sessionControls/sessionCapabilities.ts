import type { AgentId, AgentSessionCapabilitySupportLevel, AgentSessionCapabilities } from '../types.js';
import { AGENTS_CORE } from '../manifest.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './providerSessionBackends.js';

export type AgentSessionCapabilityKey =
  | 'sessionListing'
  | 'sessionFork.conversation'
  | 'sessionFork.fromMessage'
  | 'sessionRollback.conversation';

export const UNSUPPORTED_AGENT_SESSION_CAPABILITIES: AgentSessionCapabilities = Object.freeze({
  sessionListing: 'unsupported',
  sessionFork: Object.freeze({
    conversation: 'unsupported',
    fromMessage: 'unsupported',
  }),
  sessionRollback: Object.freeze({
    conversation: 'unsupported',
  }),
});

export function getAgentSessionCapabilities(agentId: AgentId): AgentSessionCapabilities {
  return AGENTS_CORE[agentId].sessionCapabilities ?? UNSUPPORTED_AGENT_SESSION_CAPABILITIES;
}

export function getAgentSessionCapability(agentId: AgentId, capability: AgentSessionCapabilityKey): AgentSessionCapabilitySupportLevel {
  const capabilities = getAgentSessionCapabilities(agentId);
  switch (capability) {
    case 'sessionListing':
      return capabilities.sessionListing;
    case 'sessionFork.conversation':
      return capabilities.sessionFork.conversation;
    case 'sessionFork.fromMessage':
      return capabilities.sessionFork.fromMessage;
    case 'sessionRollback.conversation':
      return capabilities.sessionRollback.conversation;
  }
}

export function isAgentSessionCapabilitySupported(agentId: AgentId, capability: AgentSessionCapabilityKey): boolean {
  return getAgentSessionCapability(agentId, capability) === 'supported';
}

export function evaluateAgentSessionCapabilitySupport(params: Readonly<{
  agentId: AgentId;
  capability: AgentSessionCapabilityKey;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): AgentSessionCapabilitySupportLevel {
  const effectiveRuntimeControlSurface = resolveAgentRuntimeControlSurfaceForSession(params);

  const baseSupport = effectiveRuntimeControlSurface
    ? readCapabilityFromSurface(effectiveRuntimeControlSurface.sessionCapabilities, params.capability)
    : getAgentSessionCapability(params.agentId, params.capability);
  if (baseSupport === 'unsupported') {
    return baseSupport;
  }

  return baseSupport;
}

function readCapabilityFromSurface(capabilities: AgentSessionCapabilities, capability: AgentSessionCapabilityKey): AgentSessionCapabilitySupportLevel {
  switch (capability) {
    case 'sessionListing':
      return capabilities.sessionListing;
    case 'sessionFork.conversation':
      return capabilities.sessionFork.conversation;
    case 'sessionFork.fromMessage':
      return capabilities.sessionFork.fromMessage;
    case 'sessionRollback.conversation':
      return capabilities.sessionRollback.conversation;
  }
}
