import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata, type LinkedExternalSessionV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import type { ExternalSessionAgentId } from '@happier-dev/protocol';
import type { BundledAgentId } from './types.js';
import { AGENT_IDS } from './types.js';
import { isLegacyConfiguredBackendSentinelId, readLegacyConfiguredBackendIdFromMetadata } from './compat/legacyConfiguredBackend.js';
import { getAgentResumeConfig } from './manifest.js';
import { resolveCanonicalAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
import { AgentExecutionTargetV1Schema, isCustomAcpAgentContributionIdentityV1, type AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { agentRoutingIdAddressesContributionIdentityV1, buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey, PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, isBundledAgentId } from './generated/agentIds.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasNonEmptyStringField(metadata: Record<string, unknown>, key: string): boolean {
  const raw = metadata[key];
  if (typeof raw !== 'string') return false;
  return raw.trim().length > 0;
}

/** Exact generated identity; a coincident local id never selects a bundled Agent. */
export function resolveBundledAgentIdFromContributionIdentity(identity: unknown): BundledAgentId | null {
  const parsed = PluginContributionIdentityV1Schema.safeParse(identity);
  if (!parsed.success) return null;
  return AGENT_IDS.find(agentId => {
    const bundled = BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId];
    return bundled.pluginId === parsed.data.pluginId && bundled.localId === parsed.data.localId;
  }) ?? null;
}

/** Normalize the qualified spelling of a bundled Agent for comparison with its host routing id. */
export function normalizeBundledAgentRoutingId(agentId: string): string {
  if (!agentId.includes('/')) return agentId;
  return resolveBundledAgentIdFromContributionIdentity(parseQualifiedPluginContributionKey(agentId)) ?? agentId;
}

/**
 * A declared Session identity is an open Agent contribution identity.
 *
 * Bundled Agent facts remain keyed by `BundledAgentId`; this type is the
 * metadata boundary, where a current installed contribution may legitimately
 * have an id outside that closed generated set.
 */
export type SessionMetadataAgentId = ExternalSessionAgentId;

function normalizeResolvedAgentId(value: unknown): SessionMetadataAgentId | null {
  if (isLegacyConfiguredBackendSentinelId(value)) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveDeclaredAgentIdFromSessionMetadata(
  metadata: unknown,
  /** Reuse Protocol-admitted evidence: undefined reads metadata; null proves no readable link. */
  admittedLinkedSession?: LinkedExternalSessionV1 | null,
): SessionMetadataAgentId | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(record);
  const runtimeDescriptorProviderId = normalizeResolvedAgentId(runtimeDescriptor?.agentId);
  if (runtimeDescriptorProviderId) {
    return runtimeDescriptorProviderId;
  }

  const linkedAgentId = normalizeResolvedAgentId(
    (admittedLinkedSession === undefined ? readNonAuthoritativeLinkedExternalSessionV1FromMetadata(record) : admittedLinkedSession)?.agentId,
  );
  if (linkedAgentId) {
    return linkedAgentId;
  }

  return null;
}

/** Which evidence tier decided the Agent identity carried by Session metadata. */
export type SessionMetadataAgentIdentityBasis = 'declared' | 'flavor' | 'vendorResumeKey' | 'birth' | 'none';

/**
 * Canonical Agent-identity reading of Session metadata.
 *
 * Precedence is authority-ordered, not evidence-counting: a declared runtime or
 * linked-external identity wins, then `flavor`, then a flat vendor resume key.
 * Only before a runtime identity exists can the committed birth select its Agent.
 * Several non-empty flat keys with no
 * higher authority are ambiguous and fail closed rather than silently selecting
 * the first Agent in catalog order.
 *
 * `REQ-STATE-01` keeps active metadata at zero or one non-empty flat key, so a
 * multi-key Session is legacy or corrupt state. Consumers must not treat extra
 * stale keys as a conflict when a higher-authority identity is present — doing
 * so makes such a Session permanently unresumable.
 */
export type SessionMetadataAgentIdentityV1 = Readonly<{
  /** Authoritative Agent, or `null` when identity is unknown or ambiguous. */
  agentId: SessionMetadataAgentId | null;
  basis: SessionMetadataAgentIdentityBasis;
  /** Every bundled Agent whose flat vendor resume key is non-empty, in catalog order. */
  vendorResumeKeyAgentIds: readonly BundledAgentId[];
  /** True when no higher-authority identity exists and several flat keys do. */
  ambiguousVendorResumeKeys: boolean;
}>;

function readVendorResumeKeyAgentIds(record: Record<string, unknown>): readonly BundledAgentId[] {
  const agentIds: BundledAgentId[] = [];
  for (const id of AGENT_IDS) {
    const resume = getAgentResumeConfig(id);
    const field = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
    if (!field) continue;
    if (hasNonEmptyStringField(record, field)) agentIds.push(id);
  }
  return agentIds;
}

export function resolveSessionMetadataAgentIdentity(metadata: unknown, admittedLinkedSession?: LinkedExternalSessionV1 | null): SessionMetadataAgentIdentityV1 {
  const record = asRecord(metadata);
  if (!record) {
    return { agentId: null, basis: 'none', vendorResumeKeyAgentIds: [], ambiguousVendorResumeKeys: false };
  }

  const vendorResumeKeyAgentIds = readVendorResumeKeyAgentIds(record);

  const declaredAgentId = resolveDeclaredAgentIdFromSessionMetadata(record, admittedLinkedSession);
  if (declaredAgentId) {
    return {
      agentId: declaredAgentId,
      basis: 'declared',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  const qualifiedFlavor = parseQualifiedPluginContributionKey(record.flavor);
  const flavorAgentId = resolveCanonicalAgentIdFromFlavor(record.flavor)
    ?? (qualifiedFlavor ? buildQualifiedPluginContributionKey(qualifiedFlavor) : null);
  if (flavorAgentId) {
    return {
      agentId: flavorAgentId,
      basis: 'flavor',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  if (vendorResumeKeyAgentIds.length === 1) {
    return {
      agentId: vendorResumeKeyAgentIds[0] ?? null,
      basis: 'vendorResumeKey',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  // Immutable creation provenance selects the first launch, never a later
  // cutover. Keep its basis distinct so launch consumers retain initial choices.
  const birth = SessionCreationCorrespondenceV1ReadSchema.safeParse(record.sessionCreationCorrespondenceV1);
  if (birth.success && vendorResumeKeyAgentIds.length === 0
    && !readAcpConfiguredBackendV1FromMetadata(record)
    && !readLegacyConfiguredBackendIdFromMetadata(record)) {
    const identity = birth.data.recipe.agentTarget.identity;
    return {
      agentId: resolveBundledAgentIdFromContributionIdentity(identity) ?? buildQualifiedPluginContributionKey(identity),
      basis: 'birth',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  return {
    agentId: null,
    basis: 'none',
    vendorResumeKeyAgentIds,
    ambiguousVendorResumeKeys: vendorResumeKeyAgentIds.length > 1,
  };
}

/**
 * The Agent a Session declares, or `null` when identity is unknown or ambiguous.
 *
 * This is the only Agent-identity reading of Session metadata. Callers own the
 * unknown case explicitly; nothing here substitutes a default Agent, because a
 * substituted identity is indistinguishable from a declared one downstream.
 */
export function resolveAgentIdFromSessionMetadata(
  metadata: unknown,
  admittedLinkedSession?: LinkedExternalSessionV1 | null,
): SessionMetadataAgentId | null {
  return resolveSessionMetadataAgentIdentity(metadata, admittedLinkedSession).agentId;
}

/** Shared qualified target projection for already-opened Session metadata. */
export function resolveAgentExecutionTargetFromSessionMetadata(
  metadata: unknown,
  resolvedAgentId?: string | null,
  admittedLinkedSession?: LinkedExternalSessionV1 | null,
): AgentExecutionTargetV1 | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const rawAgent = typeof record.agent === 'string' ? record.agent.trim() : null;
  const agentId = resolvedAgentId === undefined
    ? resolveAgentIdFromSessionMetadata(record, admittedLinkedSession) ?? (isBundledAgentId(rawAgent) ? rawAgent : null)
    : resolvedAgentId;
  const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(record.sessionCreationCorrespondenceV1);
  const linked = admittedLinkedSession === undefined ? resolveLinkedExternalSessionMetadataV1(record, 'stored') : null;
  const linkedSession = admittedLinkedSession === undefined ? linked?.ok ? linked.linkedSession : null : admittedLinkedSession;
  const bundledIdentity = agentId && isBundledAgentId(agentId) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId] : null;
  const currentIdentity = bundledIdentity ?? parseQualifiedPluginContributionKey(agentId);
  const matchesCurrentAgent = (identity: { pluginId: string; localId: string }): boolean => currentIdentity
    ? currentIdentity.pluginId === identity.pluginId && currentIdentity.localId === identity.localId
    : !agentId || agentRoutingIdAddressesContributionIdentityV1(agentId, identity);
  const configuredBackend = readAcpConfiguredBackendV1FromMetadata(record);
  if (configuredBackend && !isCustomAcpAgentContributionIdentityV1(currentIdentity)) return null;
  if (isCustomAcpAgentContributionIdentityV1(currentIdentity)) {
    const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(record);
    if (runtimeDescriptor || configuredBackend) {
      const definitionId = runtimeDescriptor ? runtimeDescriptor.agent.definitionId : configuredBackend?.backendId;
      if (runtimeDescriptor && configuredBackend && definitionId !== configuredBackend.backendId) return null;
      const current = AgentExecutionTargetV1Schema.safeParse({ kind: 'agent', identity: currentIdentity, definitionId });
      return current.success ? current.data : null;
    }
  }
  // Birth is immutable provenance. It may supply a matching configured
  // definition, but cannot select the departing Agent after a cutover.
  const candidate = correspondence.success && matchesCurrentAgent(correspondence.data.recipe.agentTarget.identity)
    ? correspondence.data.recipe.agentTarget
    : linkedSession?.qualifiedIdentity && matchesCurrentAgent(linkedSession.qualifiedIdentity.agent)
      ? { kind: 'agent' as const, identity: linkedSession.qualifiedIdentity.agent }
      : currentIdentity ? { kind: 'agent' as const, identity: currentIdentity } : null;
  const parsed = AgentExecutionTargetV1Schema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data;
}
