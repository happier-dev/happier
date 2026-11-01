import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { PluginAgentSessionCompactionCapabilityV2Schema, type AgentSessionCompactionCapability } from '@happier-dev/protocol/plugins/agents';

import {
  isBundledAgentId,
  type AgentId,
  type AgentSessionCapabilitySupportLevel,
  type AgentSessionCapabilities,
} from '../../types.js';
import { getAgentCore } from '../../manifest.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './runtimeControlSurface.js';
import type { RuntimeCapabilities } from '../../runtime/capabilities/runtimeCapabilities.js';
import { publishRuntimeCapabilities } from '../../runtime/capabilities/runtimeCapabilitiesPublication.js';

export type AgentSessionCapabilityKey =
  | 'sessionListing'
  | 'sessionFork.conversation'
  | 'sessionFork.fromMessage'
  | 'sessionRollback.conversation'
  | 'usageReporting'
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
  return getAgentCore(agentId)?.sessionCapabilities ?? UNSUPPORTED_AGENT_SESSION_CAPABILITIES;
}

/** An opened runtime's publication replaces the declaration, including absence. */
export function readEffectiveAgentSessionCompactionCapability(params: Readonly<{
  declaredCapability?: AgentSessionCompactionCapability | null;
  publishedSessionCapabilities?: Pick<AgentSessionCapabilities, 'compaction'> | null;
}>): AgentSessionCompactionCapability | null {
  return params.publishedSessionCapabilities === undefined
    ? params.declaredCapability ?? null
    : params.publishedSessionCapabilities?.compaction ?? null;
}

export function evaluateAgentSessionCompactionCapability(params: Readonly<{
  agentId: string;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
  declaredCapability?: AgentSessionCompactionCapability | null;
}>): AgentSessionCompactionCapability | null {
  if (params.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)) {
    const publication = (params.metadata as Readonly<Record<string, unknown>>).agentRuntimeCapabilitiesV1;
    if (publication && typeof publication === 'object' && !Array.isArray(publication)) {
      const capabilities = (publication as Readonly<Record<string, unknown>>).sessionCapabilities;
      if (capabilities !== undefined) {
        if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
        const descriptor = (capabilities as Readonly<Record<string, unknown>>).compaction;
        if (descriptor == null) return null;
        const parsed = PluginAgentSessionCompactionCapabilityV2Schema.safeParse(descriptor);
        return parsed.success ? parsed.data : null;
      }
    }
  }
  if (params.declaredCapability !== undefined) return params.declaredCapability;
  if (!isBundledAgentId(params.agentId)) return null;
  const surface = resolveAgentRuntimeControlSurfaceForSession(params);
  return surface?.sessionCapabilities.compaction ?? null;
}

export function getAgentSessionCapability(agentId: AgentId, capability: AgentSessionCapabilityKey): AgentSessionCapabilitySupportLevel {
  return readAgentSessionCapabilityFromSurface(getAgentSessionCapabilities(agentId), capability);
}

export function isAgentSessionCapabilitySupported(agentId: AgentId, capability: AgentSessionCapabilityKey): boolean {
  return getAgentSessionCapability(agentId, capability) === 'supported';
}

export function evaluateAgentSessionCapabilitySupport(params: Readonly<{
  agentId: string;
  capability: AgentSessionCapabilityKey;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
  declaredSupport?: AgentSessionCapabilitySupportLevel;
}>): AgentSessionCapabilitySupportLevel {
  // Usage-limit recovery is a static executable-operation declaration. A
  // concrete runtime may refine runtime-kind facts such as fork/rollback, but
  // it cannot invent or suppress this author contract independently.
  if (
    params.capability === 'usageLimitRecovery.checkNow'
    && params.declaredSupport
  ) {
    return params.declaredSupport;
  }
  const publishedSupport = readPublishedAgentSessionCapability(
    params.metadata,
    params.capability,
  );
  if (publishedSupport) return publishedSupport;

  // A caller holding the current normalized Agent declaration has already
  // selected the authoritative static evidence channel. Apply it identically
  // for bundled and external origins; only legacy callers without that
  // declaration use the bundled compatibility resolver below.
  if (params.declaredSupport) return params.declaredSupport;

  if (!isBundledAgentId(params.agentId)) {
    return 'unsupported';
  }

  const effectiveRuntimeControlSurface = resolveAgentRuntimeControlSurfaceForSession(params);

  if (!effectiveRuntimeControlSurface && readRuntimeDescriptorV1FromMetadata(params.metadata)) {
    return 'unsupported';
  }

  const baseSupport = effectiveRuntimeControlSurface
    ? readAgentSessionCapabilityFromSurface(effectiveRuntimeControlSurface.sessionCapabilities, params.capability)
    : getAgentSessionCapability(params.agentId, params.capability);
  if (baseSupport === 'unsupported') {
    return baseSupport;
  }

  return baseSupport;
}

function readPublishedAgentSessionCapability(
  metadata: unknown,
  capability: AgentSessionCapabilityKey,
): AgentSessionCapabilitySupportLevel | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const publication = (metadata as Readonly<Record<string, unknown>>).agentRuntimeCapabilitiesV1;
  if (!publication || typeof publication !== 'object' || Array.isArray(publication)) return null;
  const sessionCapabilities = (publication as Readonly<Record<string, unknown>>).sessionCapabilities;
  if (!sessionCapabilities || typeof sessionCapabilities !== 'object' || Array.isArray(sessionCapabilities)) {
    return null;
  }

  const sessionCapabilityRecord = sessionCapabilities as Readonly<Record<string, unknown>>;
  const value = capability.includes('.')
    ? capability.split('.').reduce<unknown>((current, segment) => (
        current && typeof current === 'object' && !Array.isArray(current)
          ? (current as Readonly<Record<string, unknown>>)[segment]
          : undefined
      ), sessionCapabilityRecord)
    : sessionCapabilityRecord[capability];

  return value === 'supported' || value === 'experimental' || value === 'unsupported'
    ? value
    : null;
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

/**
 * Reads one declared capability out of an already-resolved control surface.
 *
 * This is the single place the surface's per-capability shape is decoded, so a
 * caller that already holds the Session's effective surface reads it here
 * instead of re-resolving the surface once per question.
 */
export function readAgentSessionCapabilityFromSurface(capabilities: AgentSessionCapabilities, capability: AgentSessionCapabilityKey): AgentSessionCapabilitySupportLevel {
  switch (capability) {
    case 'sessionListing':
      return capabilities.sessionListing;
    case 'sessionFork.conversation':
      return capabilities.sessionFork.conversation;
    case 'sessionFork.fromMessage':
      return capabilities.sessionFork.fromMessage;
    case 'sessionRollback.conversation':
      return capabilities.sessionRollback.conversation;
    case 'usageReporting':
      return capabilities.usageReporting ?? 'unsupported';
    case 'usageLimitRecovery.checkNow':
      return capabilities.usageLimitRecovery?.checkNow ?? 'unsupported';
  }
}
