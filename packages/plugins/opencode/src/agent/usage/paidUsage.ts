import { isRecord } from '@happier-dev/plugin-sdk';
import type { OpenCodeServerDialect } from '../runtime/server/dialect.js';

const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Retained assistant aggregates, not step-finish parts. V1 output includes
 * reasoning; V2 output is visible output, with disjoint reasoning. Preserve both
 * native conventions and report their flags. Native cost is a model-price estimate. */
export function normalizeOpenCodePaidUsage(info: Readonly<Record<string, unknown>>, dialect: OpenCodeServerDialect) {
  if (!isRecord(info.tokens)) return null;
  const raw = info.tokens; const cache = isRecord(raw.cache) ? raw.cache : {};
  const input = number(raw.input); const output = number(raw.output);
  const cacheRead = number(cache.read); const cacheWrite = number(cache.write);
  const reasoning = number(raw.reasoning); const total = number(raw.total);
  if ([input, output, cacheRead, cacheWrite, reasoning, total].every((value) => value === null)) return null;
  const estimated = number(info.cost);
  return { tokens: { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0,
    reasoning: reasoning ?? 0, total: total ?? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (dialect === 'v2' ? reasoning ?? 0 : 0) },
  inputIncludesCache: false, outputIncludesReasoning: dialect === 'v1',
  cost: estimated === null ? null : { reportedUsd: 0, estimatedUsd: estimated, currency: 'USD' as const,
    billingContext: 'unknown' as const, costSource: 'pricing_estimate' as const } };
}
