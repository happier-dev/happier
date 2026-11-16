import { isRecord } from '@happier-dev/plugin-sdk';
import type { UsageObservationCost, UsageObservationTokens } from '@happier-dev/plugin-sdk/agents/runtime';

function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }

/** Pi 0.82.1 input/cache counters are disjoint; reasoning is included in output. */
export function normalizePiPaidUsage(value: unknown, stopReason?: unknown): Readonly<{ tokens: UsageObservationTokens; cost: UsageObservationCost | null }> | null {
  if (!isRecord(value)) return null;
  const input = number(value.input); const output = number(value.output);
  const reasoning = number(value.reasoning);
  const cacheRead = number(value.cacheRead); const cacheWrite = number(value.cacheWrite); const total = number(value.totalTokens);
  const nativeCost = isRecord(value.cost) ? value.cost : null;
  const amount = number(nativeCost?.total);
  const fromProvider = nativeCost?.totalFromProvider === true;
  const measurements = [input, output, cacheRead, cacheWrite, total, amount];
  if (reasoning === null && measurements.every(entry => entry === null)) return null;
  // Pi 0.82.1 initializes Usage to zero before a response and retains it on errors.
  // A failed all-zero message cannot witness those measurements; paid partial failures can.
  if (!fromProvider && (stopReason === 'error' || stopReason === 'aborted')
    && (reasoning === null || reasoning === 0) && measurements.every(entry => entry === 0)) {
    return { tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null }, cost: null };
  }
  // A zero estimate explicitly marked as not provider-reported supplies no charge.
  // Retain legacy estimates without that marker and genuine reported zero charges.
  const cost: UsageObservationCost | null = amount === null || amount === 0 && nativeCost?.totalFromProvider === false ? null
    : { reportedUsd: fromProvider ? amount : null, estimatedUsd: fromProvider ? null : amount,
      currency: 'USD', billingContext: 'unknown', costSource: fromProvider ? 'provider_reported' : 'pricing_estimate' };
  return { tokens: { input, output, cacheRead, cacheWrite, reasoning, total }, cost };
}
