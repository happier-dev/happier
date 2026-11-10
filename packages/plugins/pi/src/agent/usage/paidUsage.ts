import { isRecord } from '@happier-dev/plugin-sdk';
import type { UsageObservationCost, UsageObservationTokens } from '@happier-dev/plugin-sdk/agents/runtime';

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

/** Pi 0.82.1 Usage has disjoint input/output/cache counters and model-price cost. */
export function normalizePiPaidUsage(value: unknown, stopReason?: unknown): Readonly<{ tokens: UsageObservationTokens; cost: UsageObservationCost | null }> | null {
  if (!isRecord(value)) return null;
  const input = number(value.input); const output = number(value.output);
  const cacheRead = number(value.cacheRead); const cacheWrite = number(value.cacheWrite); const total = number(value.totalTokens);
  const estimate = isRecord(value.cost) ? number(value.cost.total) : null;
  const measurements = [input, output, cacheRead, cacheWrite, total, estimate];
  if (measurements.every(entry => entry === null)) return null;
  // Pi 0.82.1 initializes Usage to zero before a response and retains it on errors.
  // A failed all-zero message cannot witness those measurements; paid partial failures can.
  if ((stopReason === 'error' || stopReason === 'aborted') && measurements.every(entry => entry === 0)) {
    return { tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null }, cost: null };
  }
  return { tokens: { input, output, cacheRead, cacheWrite, reasoning: null, total },
  cost: estimate === null ? null : { reportedUsd: null, estimatedUsd: estimate, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' } };
}
