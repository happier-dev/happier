import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsCostFactValueSchema, type UsageAnalyticsCostFact } from './usageAnalyticsContracts.js';

/** A total preserves every contributing source; it never impersonates one producer. */
export const UsageCostFactTotalSchema = lazyZodSchema(() => UsageAnalyticsCostFactValueSchema.safeExtend({
  sources: z.array(z.string().trim().min(1)).min(1),
}));
export type UsageCostFactTotal = z.infer<typeof UsageCostFactTotalSchema>;

/** Inputs are already reconciled accounting facts. Denominations and money kinds remain separate. */
export function projectUsageCostFactTotals(facts: readonly UsageAnalyticsCostFact[]): UsageCostFactTotal[] {
  const totals = new Map<string, UsageCostFactTotal>();
  for (const { source, ...fact } of facts) {
    const key = JSON.stringify([fact.kind, fact.currency]);
    const previous = totals.get(key);
    if (!previous) {
      totals.set(key, { ...fact, tokens: { ...fact.tokens }, sources: [source] });
      continue;
    }
    totals.set(key, {
      kind: fact.kind, currency: fact.currency,
      amountUsd: previous.amountUsd === null || fact.amountUsd === null ? null : previous.amountUsd + fact.amountUsd,
      tokens: {
        input: previous.tokens.input + fact.tokens.input, output: previous.tokens.output + fact.tokens.output,
        reasoning: previous.tokens.reasoning + fact.tokens.reasoning, cacheRead: previous.tokens.cacheRead + fact.tokens.cacheRead,
        cacheWrite: previous.tokens.cacheWrite + fact.tokens.cacheWrite, total: previous.tokens.total + fact.tokens.total,
      },
      eventCount: previous.eventCount + fact.eventCount,
      asOfMs: Math.min(previous.asOfMs, fact.asOfMs), complete: previous.complete && fact.complete,
      sources: previous.sources.includes(source) ? previous.sources : [...previous.sources, source],
    });
  }
  return [...totals.values()];
}
