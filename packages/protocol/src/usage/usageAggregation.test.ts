import { expect, it } from 'vitest';
import { addUsageTokens, createEmptyUsageTokens, addUsageCostForMode, aggregateUsageContributionCosts, aggregateUsageCostPartitions, aggregateUsageCosts, resolveUsageContributionCosts, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveUsageCostBasis } from './usageCost.js';
import { projectUsageContributionTotals } from './usageActivityProjectionFacts.js';
import { normalizeLegacyUsageTokens } from './legacyUsageTokens.js';
import { aggregateUsageCostFactTotals } from './usageCostFactTotals.js';
import { addUsageMoney, readUsageMoney, restoreUsageMoneyProvenance, serializeUsageMoneyProvenance,
    withUsageMoney } from './usageMoney.js';

it.each(['auto', 'reported', 'estimated', 'api_equivalent'] as const)(
    'publishes empty population totals as zero without measuring nonempty missing facts in %s mode', mode => {
        const unknown = createEmptyUsageTokens();
        const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        const unknownCost = { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD', costSource: 'none' as const };
        const fold = (rows: Array<{ eventCount: number; tokens: typeof unknown; cost: typeof unknownCost }>) =>
            projectUsageContributionTotals(rows, aggregateUsageContributionCosts(rows, mode));
        const empty = fold([]);
        expect(empty).toMatchObject({ eventCount: 0, tokens: zero,
            cost: { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, costSource: 'none' } });
        expect(resolveUsageCostBasis(empty.cost, mode)).toBeNull();
        const missing = fold([{ eventCount: 1, tokens: unknown, cost: unknownCost }]);
        expect(missing.tokens).toEqual(unknown);
        expect(missing.cost).toMatchObject(unknownCost);
        expect(resolveUsageCostBasis(missing.cost, mode)).toBeNull();
        const report = projectUsageContributionTotals([{ eventCount: 0, tokens: unknown }],
            aggregateUsageContributionCosts([{ cost: { ...unknownCost, reportedUsd: 3, costSource: 'provider_reported' } }], mode));
        expect(report).toMatchObject({ eventCount: 0, tokens: unknown, cost: { reportedUsd: 3 } });
        expect(projectUsageContributionTotals([{ eventCount: 1, tokens: zero }], unknownCost).tokens).toEqual(zero);
        expect(projectUsageContributionTotals([{ eventCount: 1, tokens: unknown }, { eventCount: 1, tokens: zero }], unknownCost).tokens).toEqual(zero);
    });

it('skips unmeasured token operands while preserving unknown-only categories and measured zero', () => {
    const unknown = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
    expect(addUsageTokens(unknown, unknown)).toEqual(unknown);
    expect(addUsageTokens(unknown, { ...unknown, input: 12, output: 0 })).toEqual({ ...unknown, input: 12, output: 0 });
    expect(addUsageTokens(createEmptyUsageTokens(), unknown)).toEqual(unknown);
    expect(normalizeLegacyUsageTokens({ input: 12, output: 0 })).toEqual({ ...unknown, input: 12, output: 0 });
});

it('skips unmeasured money without fabricating a zero price fact', () => {
    const unknown = { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD', costSource: 'none' as const };
    const measured = { ...unknown, reportedUsd: 0.1, costSource: 'provider_reported' as const };
    expect(aggregateUsageCosts([unknown, unknown])).toMatchObject(unknown);
    expect(aggregateUsageCosts([unknown, measured])).toMatchObject({ reportedUsd: 0.1, estimatedUsd: null, invoiceUsd: null });
    expect(resolveUsageCostBasis(aggregateUsageContributionCosts([{ cost: unknown }, { cost: measured }], 'auto'), 'auto'))
        .toMatchObject({ amountUsd: 0.1 });
    expect(resolveUsageCostBasis({ ...unknown, costSource: 'provider_reported' }, 'auto')).toBeNull();
    expect(resolveUsageCostBasis({ ...unknown, reportedUsd: 0, costSource: 'provider_reported' }, 'auto')).toMatchObject({ amountUsd: 0 });
});

it('preserves known source-fact money when another source did not measure that kind', () => {
    const tokens = createEmptyUsageTokens();
    const base = { kind: 'reported' as const, currency: 'USD', source: 'provider', tokens, eventCount: 1, asOfMs: 1, complete: false };
    expect(aggregateUsageCostFactTotals([{ ...base, amountUsd: null }, { ...base, amountUsd: 0.2 }])[0]?.amountUsd).toBe(0.2);
    expect(aggregateUsageCostFactTotals([{ ...base, amountUsd: 0.2 }, { ...base, amountUsd: null }])[0]?.amountUsd).toBe(0.2);
    expect(aggregateUsageCostFactTotals([{ ...base, amountUsd: null }, { ...base, amountUsd: null }])[0]?.amountUsd).toBeNull();
});

it.each([0, 0.25])('ignores unmeasured default currency when folding a measured EUR amount of %s', amount => {
    const unknown = { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, currency: 'USD', costSource: 'none' as const };
    const measured = { ...unknown, reportedUsd: amount, currency: 'EUR', costSource: 'provider_reported' as const };
    for (const costs of [[unknown, measured], [measured, unknown]]) {
        const total = aggregateUsageCosts(costs);
        expect(total).toMatchObject({ reportedUsd: amount, currency: 'EUR', costSource: 'provider_reported' });
        expect(resolveUsageCostBasis(total, 'reported')).toMatchObject({ amountUsd: amount, currency: 'EUR' });
    }
    expect(aggregateUsageCosts([measured, { ...measured, currency: 'USD' }])).toMatchObject({ currency: 'MIXED' });
});

it('preserves an admitted covered partition when aggregating it again with its reported total', () => {
    const delta = { id: 'delta', cost: { reportedUsd: 0, estimatedUsd: 0.2, currency: 'USD',
        costSource: 'pricing_estimate' as const, reportedTotalId: 'total' } };
    const total = { id: 'total', cost: { reportedUsd: 1.25, estimatedUsd: 0, currency: 'USD',
        costSource: 'provider_reported' as const, reportedTotalContributionIds: ['delta'] } };
    const admitted = resolveUsageContributionCosts([delta, total], 'auto');
    const partitions = admitted.map(cost => aggregateUsageContributionCosts([{ cost }], 'auto'));
    const actual = aggregateUsageContributionCosts(partitions.map(cost => ({ cost })), 'auto');
    expect(resolveUsageCostBasis(actual, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 1.25 });
    expect(actual.estimatedUsd).toBe(0.2);
    const unpriced = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
    expect(resolveUsageCostBasis(aggregateUsageContributionCosts([{ cost: actual }, { cost: unpriced }], 'auto'), 'auto'))
        .toMatchObject({ amountUsd: 1.25 });
});

it('round-trips admitted exact operands through a compact JSON checkpoint', () => {
    const admitted = withUsageMoney({ reportedUsd: 0.1 },
        { reportedUsd: { units: 100000000000000001n, scale: 18 } });
    const encoded = JSON.parse(JSON.stringify({ value: admitted,
        exact: serializeUsageMoneyProvenance(admitted) })) as { value: typeof admitted;
        exact: ReturnType<typeof serializeUsageMoneyProvenance> };
    const restored = restoreUsageMoneyProvenance(encoded.value, encoded.exact);
    const residue = addUsageMoney(readUsageMoney(restored, 'reportedUsd', restored.reportedUsd),
        { units: -100000000000000000n, scale: 18 });
    expect(residue).toEqual({ units: 1n, scale: 18 });
});

it('consumes each admitted decimal scale once while accumulating a pricing group', () => {
    let scales = 0;
    const count = 128;
    const costs = Array.from({ length: count }, () => withUsageMoney({ reportedUsd: 0.001,
        estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const }, {
        reportedUsd: { units: 1n, get scale() { scales++; return 3; } },
    }));
    const total = aggregateUsageCosts(costs);
    expect(total.reportedUsd).toBe(0.128);
    expect(scales, 'a group holds compact running operands instead of normalizing public intermediates').toBe(count);
});

it.each([{ count: 128, expected: 6.528, units: 6528n }, { count: 66_114, expected: 3371.814, units: 3371814n }])(
    'consumes admitted decimal scales once per raw and selected channel in a $count-row priced partition', ({ count, expected, units }) => {
    let scales = 0;
    const costs = Array.from({ length: count }, (_, index) => withUsageMoney({ reportedUsd: 0,
        estimatedUsd: index % 2 === 0 ? 0.1 : 0.002, currency: 'USD', costSource: 'pricing_estimate' as const }, {
        estimatedUsd: { units: index % 2 === 0 ? 1n : 2n, get scale() { scales++; return index % 2 === 0 ? 1 : 3; } },
    }));
    scales = 0;
    const total = aggregateUsageCostPartitions(costs, 'estimated');
    expect(total.estimatedUsd).toBe(expected);
    expect(total.effectiveUsd).toBe(expected);
    expect(scales, 'raw facts and their selected sum each admit the decimal operand once').toBe(count * 2);
    expect(readUsageMoney(total, 'estimatedUsd', total.estimatedUsd)).toEqual({ units, scale: 3 });
});

it('preserves arbitrary admitted breakdown keys when grouping monetary operands', () => {
    const breakdown = Object.fromEntries([['__proto__', 0.1], ['constructor', 0.2], ['toString', 0.3]]);
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const, breakdown };
    expect(JSON.stringify(aggregateUsageCosts([cost, cost]).breakdown)).toBe(
        JSON.stringify(Object.fromEntries([['__proto__', 0.2], ['constructor', 0.4], ['toString', 0.6]])));
});

it('folds a non-replayable money stream once without retaining a materialized operand population', () => {
    const costs = [0.1, 0.2, 0.3].map(amount => ({ reportedUsd: amount, estimatedUsd: 0,
        currency: 'USD', costSource: 'provider_reported' as const, breakdown: { credit: amount } }));
    const expected = aggregateUsageCosts(costs);
    let visits = 0;
    function* stream() { for (const cost of costs) { visits++; yield cost; } }
    expect(aggregateUsageCosts(stream())).toEqual(expected);
    expect(visits).toBe(costs.length);
});

it('folds raw pricing-group operands once without selecting a mode or losing decimal precision', () => {
    const reads = new Map<number, number>();
    const costs = [0.1, 0.2, 0.3].map((amount, index) => withUsageMoney({
        get reportedUsd() { reads.set(index, (reads.get(index) ?? 0) + 1); return amount; },
        estimatedUsd: 0, invoiceUsd: amount, currency: 'EUR', billingContext: 'subscription' as const,
        costSource: 'provider_reported' as const, breakdown: { credit: amount },
    }, { reportedUsd: { units: BigInt(index + 1) * 100000000000000001n, scale: 18 } }));
    // Observe the admitted operands, after producer provenance has been attached.
    costs.forEach((cost, index) => Object.defineProperty(cost, 'reportedUsd', { enumerable: true,
        get() { reads.set(index, (reads.get(index) ?? 0) + 1); return (index + 1) / 10; } }));
    reads.clear();
    const total = aggregateUsageCosts(costs);
    expect([...reads.values()], 'each raw event enters its pricing group once').toEqual([1, 1, 1]);
    expect(total).toMatchObject({ reportedUsd: 0.6, estimatedUsd: 0, invoiceUsd: 0.6,
        currency: 'EUR', billingContext: 'subscription', costSource: 'provider_reported', breakdown: { credit: 0.6 } });
    expect(readUsageMoney(total, 'reportedUsd', total.reportedUsd)).toEqual({ units: 600000000000000006n, scale: 18 });
    expect(total).not.toHaveProperty('effectiveUsd');
    expect(aggregateUsageCosts([costs[0]!, { ...costs[1]!, currency: 'USD', billingContext: 'api', costSource: 'invoice' }]))
        .toMatchObject({ currency: 'MIXED', billingContext: 'unknown', costSource: 'none', reportedUsd: 0.3 });
});

it('admits each raw monetary operand once before aggregating a population', () => {
    const reads = new Map<string, number>();
    const rows = [0.1, 0.2, 0.3].map((amount, index) => ({ cost: Object.freeze({
        get reportedUsd() { const key = `${index}:reported`; reads.set(key, (reads.get(key) ?? 0) + 1); return amount; },
        get estimatedUsd() { const key = `${index}:estimated`; reads.set(key, (reads.get(key) ?? 0) + 1); return 0; },
        get invoiceUsd() { const key = `${index}:invoice`; reads.set(key, (reads.get(key) ?? 0) + 1); return amount; },
        get apiEquivalentUsd() { const key = `${index}:api`; reads.set(key, (reads.get(key) ?? 0) + 1); return amount * 2; },
        currency: 'USD', costSource: 'provider_reported' as const, pricingSource: 'catalog',
        breakdown: { credit: amount },
    }) }));
    const total = aggregateUsageContributionCosts(rows, 'auto');
    expect([...reads.values()], 'raw operands are admitted once, not re-read for each intermediate public total').toEqual(Array(12).fill(1));
    expect(total).toMatchObject({ reportedUsd: 0.6, invoiceUsd: 0.6, estimatedUsd: 0, apiEquivalentUsd: 1.2,
        effectiveUsd: 0.6, breakdown: { credit: 0.6 } });
    expect(resolveUsageCostBasis(total, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 0.6 });
});

it('labels best available mixed reported and current-tariff money without changing explicit tariff totals', () => {
    const reported = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const,
        apiEquivalentUsd: 2, pricingSource: 'litellm:test' };
    const equivalent = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const,
        apiEquivalentUsd: 3, pricingSource: 'litellm:test' };
    const combined = addUsageCostForMode(reported, equivalent, 'auto');
    expect(resolveUsageCostBasis(combined, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 4, currency: 'USD' });
    expect(withEffectiveUsageCost(combined, 'auto').effectiveUsd).toBe(4);
    const repeated = addUsageCostForMode(combined, reported, 'auto');
    expect(resolveUsageCostBasis(repeated, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 5, currency: 'USD' });
    expect(resolveUsageCostBasis(combined, 'api_equivalent')).toMatchObject({ amountUsd: 5 });
});

it('does not mistake a nonempty aggregate for an empty identity when its next requested basis is unavailable', () => {
    const reported = { reportedUsd: 0.1, estimatedUsd: 0.2, invoiceUsd: 0.3, currency: 'USD',
        costSource: 'provider_reported' as const, apiEquivalentUsd: 0.4, pricingSource: 'catalog' };
    const invoice = { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0.5, currency: 'USD', costSource: 'invoice' as const };
    const mixed = aggregateUsageContributionCosts([{ cost: reported }, { cost: invoice }], 'auto');
    expect(resolveUsageCostBasis(mixed, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 0.6 });
    const next = addUsageCostForMode(mixed, reported, 'reported');
    expect(resolveUsageCostBasis(next, 'reported')).toMatchObject({ amountUsd: 0.2 });
    expect(next.effectiveUsd).toBe(0.2);
    expect(next.reportedUsd).toBe(0.2);
});
