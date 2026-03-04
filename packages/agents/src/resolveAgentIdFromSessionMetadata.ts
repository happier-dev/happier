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

export function inferAgentIdFromSessionMetadata(metadata: unknown, fallback: AgentId = DEFAULT_AGENT_ID): AgentId {
  const record = asRecord(metadata);
  if (!record) return fallback;

  const byFlavor = resolveAgentIdFromFlavor(record.flavor);
  if (byFlavor) return byFlavor;

  for (const id of AGENT_IDS) {
    const field = AGENTS_CORE[id].resume.vendorResumeIdField ?? null;
    if (!field) continue;
    if (hasNonEmptyStringField(record, field)) return id;
  }

  return fallback;
}

