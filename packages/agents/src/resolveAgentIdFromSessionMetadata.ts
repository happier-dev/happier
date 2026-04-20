import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';
import type { AgentId, CanonicalAgentId } from './types.js';
import { AGENT_IDS, CANONICAL_AGENT_IDS } from './types.js';
import { isLegacyConfiguredBackendSentinelId } from './compat/legacyConfiguredBackend.js';
import { DEFAULT_AGENT_ID, getAgentResumeConfig } from './manifest.js';
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

function normalizeResolvedAgentId(value: unknown): AgentId | null {
  if (isLegacyConfiguredBackendSentinelId(value)) {
    return null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  return CANONICAL_AGENT_IDS.includes(value as CanonicalAgentId) ? (value as CanonicalAgentId) : null;
}

function readDirectSessionProviderId(metadata: Record<string, unknown>): AgentId | null {
  const directSession = asRecord(metadata.directSessionV1);
  const providerId = typeof directSession?.providerId === 'string' ? directSession.providerId.trim() : null;
  return normalizeResolvedAgentId(providerId);
}

export function resolveAgentIdFromSessionMetadata(metadata: unknown): AgentId | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const byFlavor = resolveCanonicalAgentIdFromFlavor(record.flavor);
  if (byFlavor) return byFlavor;

  const runtimeDescriptor = readRuntimeDescriptorV1FromMetadata(record);
  const runtimeDescriptorProviderId = normalizeResolvedAgentId(runtimeDescriptor?.providerId);
  if (runtimeDescriptorProviderId) {
    return runtimeDescriptorProviderId;
  }

  const directSessionProviderId = readDirectSessionProviderId(record);
  if (directSessionProviderId) {
    return directSessionProviderId;
  }

  for (const id of AGENT_IDS) {
    const resume = getAgentResumeConfig(id);
    const field = 'vendorResumeIdField' in resume ? resume.vendorResumeIdField ?? null : null;
    if (!field) continue;
    if (hasNonEmptyStringField(record, field)) return id;
  }

  return null;
}

export function inferAgentIdFromSessionMetadata(metadata: unknown, fallback: AgentId = DEFAULT_AGENT_ID): AgentId {
  return resolveAgentIdFromSessionMetadata(metadata) ?? fallback;
}
