import type { AgentAcpToolUpdatePolicy } from '@happier-dev/plugin-sdk/agents/runtime';

import type { SessionUpdate } from '@/agent/acp/updates/types';

function readPositiveInteger(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function boundUnknown(value: unknown, maxStringChars: number): unknown {
  if (typeof value === 'string') {
    return value.length <= maxStringChars ? value : value.slice(-maxStringChars);
  }
  if (Array.isArray(value)) {
    let bounded: unknown[] | null = null;
    value.forEach((entry, index) => {
      const boundedEntry = boundUnknown(entry, maxStringChars);
      if (boundedEntry === entry) return;
      bounded ??= [...value];
      bounded[index] = boundedEntry;
    });
    return bounded ?? value;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    let bounded: Record<string, unknown> | null = null;
    for (const [key, entry] of Object.entries(record)) {
      const boundedEntry = boundUnknown(entry, maxStringChars);
      if (boundedEntry === entry) continue;
      bounded ??= { ...record };
      bounded[key] = boundedEntry;
    }
    return bounded ?? value;
  }
  return value;
}

export function createAcpToolUpdatePolicy(
  definition: AgentAcpToolUpdatePolicy,
  dependencies: Readonly<{ now?: () => number }> = {},
): Readonly<{ prepare(update: SessionUpdate): SessionUpdate | null }> {
  const now = dependencies.now ?? Date.now;
  const minInProgressIntervalMs = readPositiveInteger(definition.minInProgressIntervalMs);
  const maxStringChars = readPositiveInteger(definition.maxStringChars);
  const lastInProgressUpdateAtByToolCallId = new Map<string, number>();

  return Object.freeze({
    prepare(update: SessionUpdate): SessionUpdate | null {
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
      if (toolCallId && update.sessionUpdate === 'tool_call_update') {
        if (update.status === 'in_progress' && minInProgressIntervalMs !== null) {
          const nowMs = now();
          const previousAt = lastInProgressUpdateAtByToolCallId.get(toolCallId);
          if (previousAt !== undefined && nowMs - previousAt < minInProgressIntervalMs) {
            return null;
          }
          lastInProgressUpdateAtByToolCallId.set(toolCallId, nowMs);
        } else if (
          update.status === 'completed'
          || update.status === 'failed'
          || update.status === 'cancelled'
        ) {
          lastInProgressUpdateAtByToolCallId.delete(toolCallId);
        }
      }
      return maxStringChars === null
        ? update
        : boundUnknown(update, maxStringChars) as SessionUpdate;
    },
  });
}
