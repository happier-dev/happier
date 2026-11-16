import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { expect, it, vi } from 'vitest';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { projectUsagePageCost, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

it('partitions a large admitted accounting population without scanning every row for every chart bucket', () => {
    const captured = usageQaAccountingFixture();
    const original = captured.contributions!;
    // CLIENT-PERF-R40's appended R43 capture measured a 9.717 MB Usage query.
    // Extend the anonymized QA facts to that payload scale, including its catalog.
    const encoder = new TextEncoder();
    const fixedBytes = encoder.encode(JSON.stringify({ ...captured, contributions: [] })).byteLength;
    const bytesPerRow = (encoder.encode(JSON.stringify(original)).byteLength - 2) / original.length;
    const rowCount = Math.ceil((9_717_000 - fixedBytes) / bytesPerRow);
    const day = 86_400_000;
    const start = Math.min(...original.map(row => row.observedAtMs));
    const contributions = Array.from({ length: rowCount }, (_, index) => ({
        ...original[index % original.length]!, id: `scaled-${index}`,
        // Deliberately unsorted: regrouping must preserve floating-addition order.
        observedAtMs: start + ((index * 17) % 31) * day + index,
    }));
    const buckets = Array.from({ length: 31 }, (_, index) => ({
        bucketStartMs: start + index * day, bucketEndMs: start + (index + 1) * day,
    }));
    const leader = { key: 'claude', eventCount: 1, tokens: captured.totals.tokens, cost: captured.totals.cost };
    const response: UsageAnalyticsQueryResponse = { ...captured, contributions,
        series: buckets.map(bucket => ({ ...bucket, ...captured.totals })),
        modelTimeline: buckets.map(bucket => ({ ...bucket, leaders: [leader] })),
        engineTimeline: buckets.map(bucket => ({ ...bucket, leaders: [leader] })),
    };
    const wireBytes = encoder.encode(JSON.stringify(response)).byteLength;
    // Observe the native scan boundary without replacing any domain logic.
    const filter = vi.spyOn(Array.prototype, 'filter');
    let repriced: UsageAnalyticsQueryResponse;
    let projected: ReturnType<typeof projectUsagePageCost>;
    let scans: unknown[];
    const started = performance.now();
    try {
        repriced = repriceUsageAnalyticsResponse(response, (response).priceCatalog ?? bundledUsageModelPriceCatalog);
        projected = projectUsagePageCost(repriced, 'auto');
        scans = [...filter.mock.contexts];
    } finally { filter.mockRestore(); }
    const scansByPopulation = new Map<unknown[], number>();
    for (const context of scans) {
        if (!Array.isArray(context) || context.length !== contributions.length || !context[0]
            || typeof context[0] !== 'object' || !('observedAtMs' in context[0])) continue;
        scansByPopulation.set(context, (scansByPopulation.get(context) ?? 0) + 1);
    }
    const largestScanCount = Math.max(0, ...scansByPopulation.values());
    // The composed tariff/page monetary selection retains six overlap passes.
    // No population may additionally be filtered once per chart bucket.
    console.info(JSON.stringify({ usageFreeze: true, contributions: contributions.length, wireBytes, buckets: buckets.length,
        elapsedMs: performance.now() - started, largestScanCount,
        scannedRows: [...scansByPopulation.values()].reduce((sum, count) => sum + count * contributions.length, 0) }));
    expect.soft(largestScanCount, 'chart buckets must not each filter the complete contribution inventory').toBeLessThanOrEqual(6);
    expect(projected.accounting.contributions).toBe(repriced.contributions);
    // Independent bucket queries through the real monetary owner retain every
    // amount, missing/zero fact, mixed basis and original accumulation order.
    for (const [index, bucket] of buckets.entries()) {
        const selected = contributions.filter(row => row.observedAtMs >= bucket.bucketStartMs && row.observedAtMs < bucket.bucketEndMs);
        const expected = repriceUsageAnalyticsResponse({ ...response, contributions: selected,
            series: [{ ...bucket, ...captured.totals }],
            modelTimeline: [{ ...bucket, leaders: [leader] }], engineTimeline: [{ ...bucket, leaders: [leader] }],
            leaders: undefined, breakdowns: undefined }, bundledUsageModelPriceCatalog);
        expect(repriced.series![index]!.cost).toEqual(expected.series![0]!.cost);
        expect(repriced.modelTimeline![index]).toEqual(expected.modelTimeline![0]);
        expect(repriced.engineTimeline![index]).toEqual(expected.engineTimeline![0]);
        const expectedPage = projectUsagePageCost(expected, 'auto').accounting;
        expect(projected.accounting.series![index]!.cost).toEqual(expectedPage.series![0]!.cost);
        expect(projected.accounting.modelTimeline![index]).toEqual(expectedPage.modelTimeline![0]);
        expect(projected.accounting.engineTimeline![index]).toEqual(expectedPage.engineTimeline![0]);
    }
}, 60_000);
