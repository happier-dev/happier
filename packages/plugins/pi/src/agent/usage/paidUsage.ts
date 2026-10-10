import { isRecord } from '@happier-dev/plugin-sdk';
import type { UsageObservationCost, UsageObservationTokens } from '@happier-dev/plugin-sdk/agents/runtime';

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

/** Pi 0.82.1 Usage has disjoint input/output/cache counters and model-price cost. */
export function normalizePiPaidUsage(value: unknown): Readonly<{ tokens: UsageObservationTokens; cost: UsageObservationCost | null }> | null {
  if (!isRecord(value)) return null;
  const input = number(value.input); const output = number(value.output);
  const cacheRead = number(value.cacheRead); const cacheWrite = number(value.cacheWrite); const total = number(value.totalTokens);
  if ([input, output, cacheRead, cacheWrite, total].every((entry) => entry === null)) return null;
  const estimate = isRecord(value.cost) ? number(value.cost.total) : null;
  return { tokens: { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, reasoning: 0,
    total: total ?? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) },
  cost: estimate === null ? null : { reportedUsd: 0, estimatedUsd: estimate, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' } };
}
