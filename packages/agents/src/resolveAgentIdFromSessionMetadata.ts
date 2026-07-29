import {
  readLinkedExternalSessionV1FromMetadata,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';
import type { AgentId } from './types.js';
import { AGENT_IDS, isAgentId } from './types.js';
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

  return isAgentId(value) ? value : null;
}

export function resolveDeclaredAgentIdFromSessionMetadata(metadata: unknown): AgentId | null {
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

export function resolveAgentIdFromSessionMetadata(metadata: unknown): AgentId | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const declaredAgentId = resolveDeclaredAgentIdFromSessionMetadata(record);
  if (declaredAgentId) return declaredAgentId;

  const byFlavor = resolveCanonicalAgentIdFromFlavor(record.flavor);
  if (byFlavor) return byFlavor;

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
