import type { AgentId, AgentSessionCapabilitySupportLevel, AgentSessionCapabilities } from '../../types.js';
import { getAgentCore } from '../../manifest.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';
import type { RuntimeCapabilities } from '../../runtime/capabilities/runtimeCapabilities.js';
import { publishRuntimeCapabilities } from '../../runtime/capabilities/runtimeCapabilitiesPublication.js';

export type AgentSessionCapabilityKey =
  | 'sessionListing'
  | 'sessionFork.conversation'
  | 'sessionFork.fromMessage'
  | 'sessionRollback.conversation'
  | 'usageLimitRecovery.checkNow';

export const UNSUPPORTED_AGENT_SESSION_CAPABILITIES: AgentSessionCapabilities = Object.freeze({
  sessionListing: 'unsupported',
  sessionFork: Object.freeze({
    conversation: 'unsupported',
    fromMessage: 'unsupported',
  }),
  sessionRollback: Object.freeze({
    conversation: 'unsupported',
  }),
  usageLimitRecovery: Object.freeze({
    checkNow: 'unsupported',
  }),
});

export function getAgentSessionCapabilities(agentId: AgentId): AgentSessionCapabilities {
  return getAgentCore(agentId).sessionCapabilities ?? UNSUPPORTED_AGENT_SESSION_CAPABILITIES;
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
    case 'usageLimitRecovery.checkNow':
      return capabilities.usageLimitRecovery?.checkNow ?? 'unsupported';
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

export function readRuntimeCapabilitiesForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): RuntimeCapabilities | null {
  const effectiveRuntimeControlSurface = resolveAgentRuntimeControlSurfaceForSession(params);
  if (!effectiveRuntimeControlSurface) return null;

  return publishRuntimeCapabilities({
    localControl: effectiveRuntimeControlSurface.localControl ?? null,
    sessionStorage: effectiveRuntimeControlSurface.sessionStorage,
    sessionCapabilities: effectiveRuntimeControlSurface.sessionCapabilities,
    tools: effectiveRuntimeControlSurface.tools,
    handoff: effectiveRuntimeControlSurface.handoff,
  });
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
    case 'usageLimitRecovery.checkNow':
      return capabilities.usageLimitRecovery?.checkNow ?? 'unsupported';
  }
}
