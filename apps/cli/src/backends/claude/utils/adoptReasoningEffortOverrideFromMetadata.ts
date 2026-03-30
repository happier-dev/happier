import type { Metadata } from '@/api/types';

import { resolveSessionConfigOptionOverridesFromMetadataSnapshot } from '@/agent/runtime/sessionConfigOptionOverrideSync';

function normalizeValueId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function adoptReasoningEffortOverrideFromMetadata(opts: Readonly<{
  currentValueId: string | null;
  currentUpdatedAt: number;
  metadata: Metadata | null | undefined;
}>): { valueId: string | null; updatedAt: number; didChange: boolean } {
  const candidates = resolveSessionConfigOptionOverridesFromMetadataSnapshot({ metadata: opts.metadata });
  let match: { configId: string; valueId: string; updatedAt: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.configId !== 'reasoning_effort') continue;
    if (!match || candidate.updatedAt > match.updatedAt) {
      match = candidate;
    }
  }
  if (!match) {
    return { valueId: opts.currentValueId, updatedAt: opts.currentUpdatedAt, didChange: false };
  }

  if (match.updatedAt <= opts.currentUpdatedAt) {
    return { valueId: opts.currentValueId, updatedAt: opts.currentUpdatedAt, didChange: false };
  }

  const valueId = normalizeValueId(match.valueId);
  if (!valueId) {
    return { valueId: opts.currentValueId, updatedAt: opts.currentUpdatedAt, didChange: false };
  }

  return { valueId, updatedAt: match.updatedAt, didChange: true };
}
