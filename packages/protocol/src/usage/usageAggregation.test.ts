import { expect, it } from 'vitest';
import { addUsageCostForMode, aggregateUsageContributionCosts, aggregateUsageCostPartitions, aggregateUsageCosts, resolveUsageContributionCosts, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveUsageCostBasis } from './usageCost.js';
import { addUsageMoney, readUsageMoney, restoreUsageMoneyProvenance, serializeUsageMoneyProvenance,
    withUsageMoney } from './usageMoney.js';

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
        .toBeNull();
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
    expect(resolveUsageCostBasis(next, 'reported')).toBeNull();
    expect(next.effectiveUsd).toBeUndefined();
    expect(next.reportedUsd).toBe(0.2);
});
