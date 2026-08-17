import { readAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import type { AgentId } from './types.js';
import { AGENT_IDS } from './types.js';
import { AGENTS_CORE, DEFAULT_AGENT_ID } from './manifest.js';
import { resolveAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasNonEmptyStringField(metadata: Record<string, unknown>, key: string): boolean {
  const raw = metadata[key];
  if (typeof raw !== 'string') return false;
  return raw.trim().length > 0;
}

/** Which evidence tier decided the Agent identity carried by Session metadata. */
export type SessionMetadataAgentIdentityBasis = 'declared' | 'flavor' | 'vendorResumeKey' | 'none';

/**
 * Canonical Agent-identity reading of Session metadata.
 *
 * Precedence is authority-ordered, not evidence-counting: a declared runtime
 * identity wins, then `flavor`, and only when neither exists may a flat vendor
 * resume key infer identity. Several non-empty flat keys with no higher
 * authority are ambiguous and fail closed rather than silently selecting the
 * first Agent in catalog order.
 *
 * Session metadata carries at most one non-empty flat vendor resume key, so a
 * multi-key Session is legacy or corrupt state. Consumers must not treat extra
 * stale keys as a conflict when a higher-authority identity is present — doing
 * so makes such a Session permanently unresumable.
 */
export type SessionMetadataAgentIdentityV1 = Readonly<{
  /** Authoritative Agent, or `null` when identity is unknown or ambiguous. */
  agentId: AgentId | null;
  basis: SessionMetadataAgentIdentityBasis;
  /** Every Agent whose flat vendor resume key is non-empty, in catalog order. */
  vendorResumeKeyAgentIds: readonly AgentId[];
  /** True when no higher-authority identity exists and several flat keys do. */
  ambiguousVendorResumeKeys: boolean;
}>;

function resolveDeclaredAgentId(record: Record<string, unknown>): AgentId | null {
  const runtimeDescriptor = readAgentRuntimeDescriptorV1(record.agentRuntimeDescriptorV1);
  if (
    runtimeDescriptor?.providerId === 'codex'
    || runtimeDescriptor?.providerId === 'opencode'
    || runtimeDescriptor?.providerId === 'pi'
  ) {
    return runtimeDescriptor.providerId;
  }
  return null;
}

function readVendorResumeKeyAgentIds(record: Record<string, unknown>): readonly AgentId[] {
  const agentIds: AgentId[] = [];
  for (const id of AGENT_IDS) {
    const field = 'vendorResumeIdField' in AGENTS_CORE[id].resume ? AGENTS_CORE[id].resume.vendorResumeIdField ?? null : null;
    if (!field) continue;
    if (hasNonEmptyStringField(record, field)) agentIds.push(id);
  }
  return agentIds;
}

export function resolveSessionMetadataAgentIdentity(metadata: unknown): SessionMetadataAgentIdentityV1 {
  const record = asRecord(metadata);
  if (!record) {
    return { agentId: null, basis: 'none', vendorResumeKeyAgentIds: [], ambiguousVendorResumeKeys: false };
  }

  const vendorResumeKeyAgentIds = readVendorResumeKeyAgentIds(record);

  const declaredAgentId = resolveDeclaredAgentId(record);
  if (declaredAgentId) {
    return {
      agentId: declaredAgentId,
      basis: 'declared',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  const flavorAgentId = resolveAgentIdFromFlavor(record.flavor);
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

  return {
    agentId: null,
    basis: 'none',
    vendorResumeKeyAgentIds,
    ambiguousVendorResumeKeys: vendorResumeKeyAgentIds.length > 1,
  };
}

export function resolveAgentIdFromSessionMetadata(metadata: unknown): AgentId | null {
  return resolveSessionMetadataAgentIdentity(metadata).agentId;
}

export function inferAgentIdFromSessionMetadata(metadata: unknown, fallback: AgentId = DEFAULT_AGENT_ID): AgentId {
  return resolveAgentIdFromSessionMetadata(metadata) ?? fallback;
}
