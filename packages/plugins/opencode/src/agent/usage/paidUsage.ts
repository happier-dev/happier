import { isRecord } from '@happier-dev/plugin-sdk';
import type { UsageObservationCost, UsageObservationTokens } from '@happier-dev/plugin-sdk/agents/runtime';
import type { OpenCodeServerDialect } from '../runtime/server/dialect.js';

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Retained assistant aggregates, not step-finish parts. V1 output includes
 * reasoning; V2 output is visible output, with disjoint reasoning. Preserve both
 * native conventions and report their flags. Native cost is a model-price estimate. */
export function normalizeOpenCodePaidUsage(info: Readonly<Record<string, unknown>>, dialect: OpenCodeServerDialect): Readonly<{
  tokens: UsageObservationTokens; cost: UsageObservationCost | null; inputIncludesCache: false; outputIncludesReasoning: boolean;
}> | null {
  const raw = isRecord(info.tokens) ? info.tokens : {}; const cache = isRecord(raw.cache) ? raw.cache : {};
  const input = number(raw.input); const output = number(raw.output);
  const cacheRead = number(cache.read); const cacheWrite = number(cache.write);
  const reasoning = number(raw.reasoning); const total = number(raw.total);
  const estimated = number(info.cost);
  if ([input, output, cacheRead, cacheWrite, reasoning, total, estimated].every((value) => value === null)) return null;
  return { tokens: { input, output, cacheRead, cacheWrite, reasoning, total },
  inputIncludesCache: false, outputIncludesReasoning: dialect === 'v1',
  cost: estimated === null ? null : { reportedUsd: null, estimatedUsd: estimated, currency: 'USD' as const,
    billingContext: 'unknown' as const, costSource: 'pricing_estimate' as const } };
}
