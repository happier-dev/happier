import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageAnalyticsCostFactValueSchema, type UsageAnalyticsCostFact } from './usageAnalyticsContracts.js';
import { addUsageTokens } from './usageAggregation.js';
import { createUsageMoneyAccumulator, readUsageMoney, transferUsageMoney, usageMoneyToNumber, withUsageMoney } from './usageMoney.js';

/** A total preserves every contributing source; it never impersonates one producer. */
export const UsageCostFactTotalSchema = lazyZodSchema(() => z.safeExtend(UsageAnalyticsCostFactValueSchema, {
  sources: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)),
}));
export type UsageCostFactTotal = z.infer<typeof UsageCostFactTotalSchema>;

/** Public totals conserve the numeric facts that survive schema admission/JSON.
 * Hidden intermediate operands cannot be part of that outward contract. */
export function projectUsageCostFactTotals(facts: readonly UsageAnalyticsCostFact[]): UsageCostFactTotal[] {
  return aggregateUsageCostFactTotals(facts.map(fact => ({
    kind: fact.kind, currency: fact.currency, amountUsd: fact.amountUsd, source: fact.source,
    eventCount: fact.eventCount, asOfMs: fact.asOfMs, complete: fact.complete,
    tokens: { input: fact.tokens.input, output: fact.tokens.output, reasoning: fact.tokens.reasoning,
      cacheRead: fact.tokens.cacheRead, cacheWrite: fact.tokens.cacheWrite, total: fact.tokens.total },
  })));
}

/** Internal grouping retains exact raw money until its source facts are published. */
export function aggregateUsageCostFactTotals(facts: Iterable<UsageAnalyticsCostFact>): UsageCostFactTotal[] {
  const groups = createUsageCostFactGroups(false);
  for (const fact of facts) groups.add(fact);
  return groups.values();
}

/** Price rows as a stream, retaining one exact accumulator per published source. */
export function createUsageSourceCostFacts() {
  const groups = createUsageCostFactGroups(true);
  return {
    add: groups.add,
    values(): UsageAnalyticsCostFact[] {
      return groups.values().map(({ sources, ...fact }) => ({ ...fact, source: sources[0]! }));
    },
  };
}

function createUsageCostFactGroups(separateSources: boolean) {
  type Group = { first: UsageCostFactTotal; amount: ReturnType<typeof createUsageMoneyAccumulator> | null;
    tokens: UsageAnalyticsCostFact['tokens']; eventCount: number; asOfMs: number;
    complete: boolean; sources: string[]; combined: boolean };
  const groups = new Map<string, Group>();
  return {
    add(fact: UsageAnalyticsCostFact, contributionCount = 1): void {
      const key = JSON.stringify(separateSources ? [fact.kind, fact.currency, fact.source] : [fact.kind, fact.currency]);
      const previous = groups.get(key);
      if (!previous) {
        const tokens = { ...fact.tokens };
        const sources = [fact.source];
        const { source: _source, ...value } = fact;
        const first = { ...value, tokens, sources };
        groups.set(key, { first: fact.amountUsd === null ? first
          : transferUsageMoney(fact, 'amountUsd', fact.amountUsd, first, 'amountUsd'),
          amount: fact.amountUsd === null ? null : createUsageMoneyAccumulator(readUsageMoney(fact, 'amountUsd', fact.amountUsd)),
          tokens, eventCount: fact.eventCount, asOfMs: fact.asOfMs, complete: fact.complete, sources, combined: contributionCount > 1 });
        return;
      }
      if (fact.amountUsd === null) previous.amount = null;
      else previous.amount?.add(readUsageMoney(fact, 'amountUsd', fact.amountUsd));
      previous.tokens = addUsageTokens(previous.tokens, fact.tokens);
      previous.eventCount += fact.eventCount;
      previous.asOfMs = Math.min(previous.asOfMs, fact.asOfMs);
      previous.complete &&= fact.complete;
      if (!previous.sources.includes(fact.source)) previous.sources = [...previous.sources, fact.source];
      previous.combined = true;
    },
    values(): UsageCostFactTotal[] {
      return [...groups.values()].map(group => {
        if (!group.combined) return group.first;
        const amount = group.amount?.value() ?? null;
        return withUsageMoney({
        kind: group.first.kind, currency: group.first.currency,
        amountUsd: amount === null ? null : usageMoneyToNumber(amount),
        tokens: group.tokens, eventCount: group.eventCount, asOfMs: group.asOfMs,
        complete: group.complete, sources: group.sources,
      }, amount === null ? {} : { amountUsd: amount });
      });
    },
  };
}
