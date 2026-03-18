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

export function resolveAgentIdFromSessionMetadata(metadata: unknown): AgentId | null {
  const record = asRecord(metadata);
  if (!record) return null;

  const byFlavor = resolveAgentIdFromFlavor(record.flavor);
  if (byFlavor) return byFlavor;

  const runtimeDescriptor = readAgentRuntimeDescriptorV1(record.agentRuntimeDescriptorV1);
  if (runtimeDescriptor?.providerId === 'codex' || runtimeDescriptor?.providerId === 'opencode' || runtimeDescriptor?.providerId === 'pi') {
    return runtimeDescriptor.providerId;
  }

  for (const id of AGENT_IDS) {
    const field = 'vendorResumeIdField' in AGENTS_CORE[id].resume ? AGENTS_CORE[id].resume.vendorResumeIdField ?? null : null;
    if (!field) continue;
    if (hasNonEmptyStringField(record, field)) return id;
  }

  return null;
}

export function inferAgentIdFromSessionMetadata(metadata: unknown, fallback: AgentId = DEFAULT_AGENT_ID): AgentId {
  return resolveAgentIdFromSessionMetadata(metadata) ?? fallback;
}
