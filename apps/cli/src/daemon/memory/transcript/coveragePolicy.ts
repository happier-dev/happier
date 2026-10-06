import { MemoryContentPolicyV1Schema, MemoryCoveragePolicyV1Schema } from '@happier-dev/protocol/memory/memorySettings';
import type { MemoryContentPolicyV1, MemoryCoveragePolicyV1, MemoryIndexPolicyV1 } from '@happier-dev/protocol';

const DAY_MS = 24 * 60 * 60 * 1_000;

type MemoryCoverageItem = Readonly<{
  seq: number;
  createdAtMs: number;
}>;

export function resolveMemoryIndexPolicy(params: Readonly<{
  coveragePolicy?: MemoryCoveragePolicyV1 | null;
  contentPolicy?: Partial<MemoryContentPolicyV1> | null;
  backfillPolicy?: 'new_only' | 'last_30_days' | 'all_history';
  enabledAtMs?: number;
}>): MemoryIndexPolicyV1 {
  return {
    coveragePolicy: MemoryCoveragePolicyV1Schema.parse(params.coveragePolicy ?? { type: 'full' }),
    contentPolicy: MemoryContentPolicyV1Schema.parse(params.contentPolicy ?? {}),
    backfillPolicy: params.backfillPolicy ?? 'all_history',
    enabledAtMs: Math.max(0, Math.trunc(params.enabledAtMs ?? 0)),
  };
}

export function memoryIndexPolicyKey(policy: MemoryIndexPolicyV1): string {
  const coverage = policy.coveragePolicy.type === 'latest_messages'
    ? { type: 'latest_messages' as const, maxSemanticMessagesPerSession: policy.coveragePolicy.maxSemanticMessagesPerSession }
    : policy.coveragePolicy.type === 'latest_days'
      ? { type: 'latest_days' as const, days: policy.coveragePolicy.days }
      : { type: policy.coveragePolicy.type };
  return JSON.stringify({
    coveragePolicy: coverage,
    contentPolicy: {
      includeUserMessages: policy.contentPolicy.includeUserMessages,
      includeAssistantMessages: policy.contentPolicy.includeAssistantMessages,
      includeReasoning: policy.contentPolicy.includeReasoning,
      includeToolSummaries: policy.contentPolicy.includeToolSummaries,
      includeToolOutputs: policy.contentPolicy.includeToolOutputs,
    },
    backfillPolicy: policy.backfillPolicy,
    enabledAtMs: policy.enabledAtMs,
  });
}

export function resolveMemoryCoverageCreatedAtCutoffMs(params: Readonly<{
  policy?: MemoryCoveragePolicyV1 | null;
  nowMs: number;
  enabledAtMs: number;
}>): number | null {
  const policy = params.policy ?? { type: 'full' };
  if (policy.type === 'latest_days') {
    return Math.max(0, Math.trunc(params.nowMs) - policy.days * DAY_MS);
  }
  if (policy.type === 'since_enabled') {
    return Math.max(0, Math.trunc(params.enabledAtMs));
  }
  return null;
}

/**
 * Applies daemon-memory coverage to already-extracted semantic transcript
 * items. Content admission deliberately runs first, so `latest_messages`
 * counts semantic messages rather than raw transport rows.
 */
export function applyMemoryCoveragePolicy<T extends MemoryCoverageItem>(params: Readonly<{
  items: readonly T[];
  policy?: MemoryCoveragePolicyV1 | null;
  nowMs: number;
  enabledAtMs: number;
  backfillPolicy?: 'new_only' | 'last_30_days' | 'all_history';
}>): T[] {
  const enabledAtMs = Math.max(0, Math.trunc(params.enabledAtMs));
  const ordered = params.items
    .filter((item) => params.backfillPolicy !== 'new_only' || item.createdAtMs >= enabledAtMs)
    .slice()
    .sort((left, right) => left.seq - right.seq);
  const policy = params.policy ?? { type: 'full' };
  if (policy.type === 'latest_messages') {
    return ordered.slice(-Math.max(1, Math.trunc(policy.maxSemanticMessagesPerSession)));
  }
  const cutoffMs = resolveMemoryCoverageCreatedAtCutoffMs(params);
  return cutoffMs === null
    ? ordered
    : ordered.filter((item) => item.createdAtMs >= cutoffMs);
}
