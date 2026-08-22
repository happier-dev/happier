import {
  readLinkedExternalSessionV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
  type ExternalSessionAgentId,
} from '@happier-dev/protocol';
import type { BundledAgentId } from './types.js';
import { AGENT_IDS } from './types.js';
import { isLegacyConfiguredBackendSentinelId } from './compat/legacyConfiguredBackend.js';
import { getAgentResumeConfig } from './manifest.js';
import { resolveCanonicalAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasNonEmptyStringField(metadata: Record<string, unknown>, key: string): boolean {
  const raw = metadata[key];
  if (typeof raw !== 'string') return false;
  return raw.trim().length > 0;
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
): SessionMetadataAgentId | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(record);
  const runtimeDescriptorProviderId = normalizeResolvedAgentId(runtimeDescriptor?.agentId);
  if (runtimeDescriptorProviderId) {
    return runtimeDescriptorProviderId;
  }

  const linkedAgentId = normalizeResolvedAgentId(
    readLinkedExternalSessionV1FromMetadata(record)?.agentId,
  );
  if (linkedAgentId) {
    return linkedAgentId;
  }

  return null;
}

/** Which evidence tier decided the Agent identity carried by Session metadata. */
export type SessionMetadataAgentIdentityBasis = 'declared' | 'flavor' | 'vendorResumeKey' | 'none';

/**
 * Canonical Agent-identity reading of Session metadata.
 *
 * Precedence is authority-ordered, not evidence-counting: a declared runtime or
 * linked-external identity wins, then `flavor`, and only when neither exists may
 * a flat vendor resume key infer identity. Several non-empty flat keys with no
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

export function resolveSessionMetadataAgentIdentity(metadata: unknown): SessionMetadataAgentIdentityV1 {
  const record = asRecord(metadata);
  if (!record) {
    return { agentId: null, basis: 'none', vendorResumeKeyAgentIds: [], ambiguousVendorResumeKeys: false };
  }

  const vendorResumeKeyAgentIds = readVendorResumeKeyAgentIds(record);

  const declaredAgentId = resolveDeclaredAgentIdFromSessionMetadata(record);
  if (declaredAgentId) {
    return {
      agentId: declaredAgentId,
      basis: 'declared',
      vendorResumeKeyAgentIds,
      ambiguousVendorResumeKeys: false,
    };
  }

  const flavorAgentId = resolveCanonicalAgentIdFromFlavor(record.flavor);
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

/**
 * The Agent a Session declares, or `null` when identity is unknown or ambiguous.
 *
 * This is the only Agent-identity reading of Session metadata. Callers own the
 * unknown case explicitly; nothing here substitutes a default Agent, because a
 * substituted identity is indistinguishable from a declared one downstream.
 */
export function resolveAgentIdFromSessionMetadata(
  metadata: unknown,
): SessionMetadataAgentId | null {
  return resolveSessionMetadataAgentIdentity(metadata).agentId;
}
