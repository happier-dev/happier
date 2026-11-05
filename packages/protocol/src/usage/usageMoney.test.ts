import { expect, it } from 'vitest';
import { aggregateUsageContributionCosts, addUsageTokens, createEmptyUsageTokens } from './usageAggregation.js';
import { estimateUsageModelCost, repriceUsageObservationCost, projectUsagePageCost, resolveUsageCostFacts } from './usageCost.js';
import { aggregateUsageCostFactTotals, createUsageSourceCostFacts, projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { formatUsageCost } from './usageFormatting.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import type { UsageAnalyticsContribution, UsageModelPriceOverridesV1, UsageObservationTokens } from '../index.js';
import { addUsageMoney, readUsageMoney, usageMoneyFromNumber, usageMoneyToNumber, withUsageMoney } from './usageMoney.js';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from './resolveUsagePageAggregation.js';
import { UsageObservationCostSchema } from './usageAnalyticsContracts.js';

const tokens = (input: number): UsageObservationTokens => ({ input, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: input });
const rates: UsageModelPriceOverridesV1 = { a: { kind: 'rates', inputUsdPerMillion: 283.3333333333333, outputUsdPerMillion: 0 },
  b: { kind: 'rates', inputUsdPerMillion: 1_000, outputUsdPerMillion: 0 } };

it('publishes the same source-fact wire representation for rows and an admitted grouped operand', () => {
  const single = { tokens: tokens(1), eventCount: 1, asOfMs: 0, complete: true,
    kind: 'reported' as const, amountUsd: 0.001, currency: 'USD', source: 'provider' };
  const admitted = createUsageSourceCostFacts();
  admitted.add(single);
  expect(JSON.stringify(admitted.values())).toBe(JSON.stringify([single]));
  const rows = createUsageSourceCostFacts();
  for (let index = 0; index < 2; index++) rows.add({ tokens: tokens(1), eventCount: 1, asOfMs: index, complete: true,
    kind: 'reported', amountUsd: 0.001, currency: 'USD', source: 'provider' });
  const grouped = createUsageSourceCostFacts();
  grouped.add({ tokens: tokens(2), eventCount: 2, asOfMs: 0, complete: true,
    kind: 'reported', amountUsd: 0.002, currency: 'USD', source: 'provider' }, 2);
  expect(JSON.stringify(grouped.values())).toBe(JSON.stringify(rows.values()));
});

it('publishes exact grouped fact money once per returned group rather than per contribution', () => {
  const measure = (count: number) => {
    const facts = Array.from({ length: count }, (_, index) => ({ kind: 'reported' as const, currency: 'USD',
      amountUsd: 0.001, source: 'provider', tokens: tokens(1), eventCount: 1, asOfMs: index, complete: true }));
    const original = Number.isFinite;
    let publications = 0;
    Number.isFinite = value => { if (typeof value === 'number' && value > 0 && value < 1) publications++; return original(value); };
    try {
      const total = aggregateUsageCostFactTotals(facts)[0]!;
      expect(total).toMatchObject({ amountUsd: count / 1000, eventCount: count, tokens: tokens(count), sources: ['provider'] });
    } finally { Number.isFinite = original; }
    return publications;
  };
  expect(measure(256), 'an exact running sum is an operand, not a public money carrier').toBe(measure(128));
});

it('reuses admitted precision across repeated projection consumers while replacing changed exact operands', () => {
  const exact = { units: 100000000000000003n, scale: 18 };
  const admitted = withUsageMoney({ amountUsd: 0.1 }, { amountUsd: exact });
  const consumers = Array.from({ length: 128 }, () => withUsageMoney(admitted,
    { amountUsd: readUsageMoney(admitted, 'amountUsd', admitted.amountUsd) }));
  expect(new Set(consumers).size, 'unchanged exact provenance must not allocate one carrier per consumer').toBe(1);
  expect(consumers[0]).toBe(admitted);
  const replacement = { units: 100000000000000004n, scale: 18 };
  const changed = withUsageMoney(admitted, { amountUsd: replacement });
  expect(changed).not.toBe(admitted);
  expect(readUsageMoney(changed, 'amountUsd', changed.amountUsd)).toBe(replacement);
  expect(readUsageMoney(admitted, 'amountUsd', admitted.amountUsd)).toBe(exact);
  expect(JSON.stringify(changed)).toBe(JSON.stringify(admitted));
});

it('admits exact cache-savings money through in-memory and serialized Usage results', () => {
  const categories = { input: 7, output: 3, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 15 };
  const estimate = estimateUsageModelCost('gpt-5', categories)!;
  const row: UsageAnalyticsContribution = { id: 'cache-savings', observedAtMs: 150, eventCount: 1,
    agentId: 'codex', modelId: 'gpt-5', sessionId: null, turnId: null, machineId: null,
    projectKey: null, workspaceId: null, source: 'native', tokens: categories,
    cost: { reportedUsd: 0, estimatedUsd: estimate.estimatedUsd, currency: 'USD', costSource: 'pricing_estimate',
      breakdown: estimate.breakdown } };
  expect(UsageObservationCostSchema.parse({ ...row.cost, breakdown: { vendorCreditUsd: 0.25 } }).breakdown)
    .toEqual({ vendorCreditUsd: 0.25 });
  expect(UsageObservationCostSchema.safeParse({ ...row.cost, breakdown: { invalid: -1 } }).success).toBe(false);
  const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeComparison: false });
  const batch = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: {
    v: 1, contributions: [row], totals: { eventCount: 1, tokens: categories,
      cost: aggregateUsageContributionCosts([row], 'auto') },
  } }] });
  for (const candidate of [batch, JSON.parse(JSON.stringify(batch))]) {
    const admitted = UsageQueryBatchResultSchema.safeParse(candidate);
    expect(admitted.success, JSON.stringify(admitted.error?.issues.map(issue => ({ code: issue.code, path: issue.path })))).toBe(true);
    expect(admitted.data?.results[0]?.accounting?.totals.cost.breakdown?.cacheSavingsUsd).toBe(estimate.breakdown!.cacheSavingsUsd);
  }
});
function contribution(input: number, index: number, modelId = 'a'): UsageAnalyticsContribution {
  return { id: String(index), observedAtMs: 1, eventCount: 1, agentId: null, modelId, sessionId: null, turnId: null,
    machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens: tokens(input),
    cost: repriceUsageObservationCost({ reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' },
      modelId, tokens(input), bundledUsageModelPriceCatalog, rates) };
}
function page(rows: UsageAnalyticsContribution[]) {
  return projectUsagePageCost({ v: 1, contributions: rows, totals: { eventCount: rows.length,
    tokens: rows.reduce((sum, row) => addUsageTokens(sum, row.tokens), createEmptyUsageTokens()),
    cost: aggregateUsageContributionCosts(rows, 'auto') } }, 'auto');
}

it('adds safe integer token fields after one precision-provenance read per operand', () => {
  let precisionReads = 0;
  const tracked = (value: UsageObservationTokens) => new Proxy(Object.freeze(value), { get(target, key, receiver) {
    if (typeof key === 'symbol') precisionReads++;
    return Reflect.get(target, key, receiver);
  } });
  const total = addUsageTokens(tracked(tokens(10)), tracked(tokens(20)));
  expect(precisionReads, 'ordinary token counts do not need six decimal-provenance reads per operand').toBe(2);
  expect(total).toEqual(tokens(30));
});

it('retains fractional and unsafe-integer precision when public token sums round to integers', () => {
  const fractional = addUsageTokens(tokens(0.10000000000000003), tokens(0.9));
  expect(fractional.input).toBe(1);
  expect(readUsageMoney(addUsageTokens(fractional, tokens(1)), 'input', 2))
    .toEqual({ units: 200000000000000003n, scale: 17 });
  const unsafe = addUsageTokens(addUsageTokens(tokens(Number.MAX_SAFE_INTEGER), tokens(1)), tokens(1));
  expect(readUsageMoney(unsafe, 'input', unsafe.input)).toEqual({ units: 9007199254740993n, scale: 0 });
  expect(usageMoneyFromNumber(1000000000000000100)).toEqual({ units: 1000000000000000100n, scale: 0 });
});

it('carries an admitted decimal operand without re-reading it just to compare its public number', () => {
  let operandReads = 0;
  const exact = Object.freeze({ get units() { operandReads++; return 3n; }, get scale() { operandReads++; return 1; } });
  const admitted = withUsageMoney({ amountUsd: 0.3 }, { amountUsd: exact });
  expect(operandReads, 'the numeric producer already supplied exact precision; consumers retain it').toBe(0);
  expect(JSON.stringify(admitted)).toBe('{"amountUsd":0.3}');
  const copied = { ...admitted };
  expect(usageMoneyToNumber(addUsageMoney(readUsageMoney(copied, 'amountUsd', copied.amountUsd), usageMoneyFromNumber(0.2)))).toBe(0.5);
  const changed = { ...admitted, amountUsd: 0.4 };
  expect(usageMoneyToNumber(readUsageMoney(changed, 'amountUsd', changed.amountUsd))).toBe(0.4);
});

it('uses the shared exact decimal baseline for row and grouped tariff targets at the formatter boundary', () => {
  // Owner ruling 2026-10-31 L0 corrects legacy IEEE-order display boundaries for both paths.
  const rich = page([1, 1, 1].map((input, index) => contribution(input, index)));
  const grouped = page([contribution(3, 0)]);
  expect(rich.amountUsd).toBe(Number('0.0008499999999999999'));
  expect(grouped.amountUsd).toBe(rich.amountUsd);
  expect(formatUsageCost(rich.amountUsd!, 'USD')).toBe('$0.0009');
  expect(formatUsageCost(grouped.amountUsd!, 'USD')).toBe('$0.0009');
});

it('makes colliding model populations independent of contribution order and partition', () => {
  // Owner ruling 2026-10-31 L0 replaces ordered IEEE accumulation, not the formatter.
  const a = page([...([1, 2, 12].map((input, index) => contribution(input, index))), contribution(1, 3, 'b')]);
  const b = page([...([1, 5, 9].map((input, index) => contribution(input, index))), contribution(1, 3, 'b')]);
  const grouped = page([contribution(15, 0), contribution(1, 1, 'b')]);
  expect(a.amountUsd).toBe(Number('0.0052499999999999995'));
  expect(b.amountUsd).toBe(a.amountUsd);
  expect(grouped.amountUsd).toBe(a.amountUsd);
  expect(formatUsageCost(b.amountUsd!, 'USD')).toBe(formatUsageCost(a.amountUsd!, 'USD'));
});

it('retains exact selected and fact money while leaving reported and invoice observations unchanged', () => {
  const costs = [0.1, 0.2].map(reportedUsd => Object.freeze({ reportedUsd, estimatedUsd: 0, invoiceUsd: reportedUsd,
    currency: 'USD', costSource: 'provider_reported' as const }));
  const total = aggregateUsageContributionCosts(costs.map(cost => ({ cost })), 'auto');
  expect(total.reportedUsd).toBe(0.3);
  expect(total.invoiceUsd).toBe(0.3);
  expect(total.effectiveUsd).toBe(0.3);
  const facts = costs.flatMap((cost, index) => resolveUsageCostFacts(cost).map(fact => ({ ...fact, tokens: tokens(1),
    eventCount: 1, asOfMs: index + 1, complete: true })));
  expect(projectUsageCostFactTotals(facts).map(fact => fact.amountUsd)).toEqual([0.3, 0.3]);
  expect(costs.map(cost => [cost.reportedUsd, cost.invoiceUsd])).toEqual([[0.1, 0.1], [0.2, 0.2]]);
  expect(() => JSON.stringify(total)).not.toThrow();
});

it('shares the immutable exact zero operand across empty monetary fields and zero arithmetic', () => {
  const zeros = Array.from({ length: 128 }, () => usageMoneyFromNumber(0));
  expect(new Set(zeros).size, 'empty money fields must not allocate an operand per contribution').toBe(1);
  expect(Object.isFrozen(zeros[0])).toBe(true);
  expect(addUsageMoney(zeros[0]!, zeros[0]!)).toBe(zeros[0]);
  expect(usageMoneyFromNumber(-0)).toBe(zeros[0]);
  expect(addUsageMoney(zeros[0]!, usageMoneyFromNumber(0.125))).toEqual({ units: 125n, scale: 3 });
});

it('derives tariff precision from validated decimal tokens and rates rather than a fixed USD scale', () => {
  const overrides: UsageModelPriceOverridesV1 = { a: { kind: 'rates', inputUsdPerMillion: 0.0000001, outputUsdPerMillion: 0 } };
  const raw = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  const priced = [0.0000001, 0.0000002].map(input => ({ cost: repriceUsageObservationCost(raw, 'a', tokens(input), bundledUsageModelPriceCatalog, overrides) }));
  expect(aggregateUsageContributionCosts(priced, 'api_equivalent').apiEquivalentUsd).toBe(3e-20);
});
