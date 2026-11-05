import { expect, it } from 'vitest';
import { repriceUsageAnalyticsResponse, projectUsagePageCost, resolveUsageCostForSelection } from './usageCost.js';
import { buildUsageBreakdownList, buildUsageLeaderList, compareUsageRankedLeaders, groupUsageLeaderSources, selectUsageLeaderTokenFrontier, selectUsageRankedLeaders } from './usageLeaderProjection.js';
import { UsageAnalyticsContributionSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

const contribution = { id: 'row', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: 'agent', modelId: 'model',
    machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    cost: { reportedUsd: 0, estimatedUsd: 0, costSource: 'none', currency: 'USD' } };

it('selects top-N with linear comparison work for a fixed one-entry demand, preserving monetary and key ties', () => {
    let costReads = 0;
    const entries = Array.from({ length: 2733 }, (_, index) => ({ key: String(index), eventCount: 1,
        tokens: contribution.tokens,
        get cost() { costReads++; return { ...contribution.cost, reportedUsd: (index * 997) % 2733,
            costSource: 'provider_reported' as const }; },
    }));
    expect(selectUsageRankedLeaders(entries, 1, 'reported').map(entry => entry.key)).toEqual(['2108']);
    expect(costReads, 'top-one admission must not sort the whole monetary population').toBeLessThan(entries.length * 4);
    const tied = ['z', 'b', 'a'].map(key => ({ key, eventCount: 2, tokens: contribution.tokens, cost: contribution.cost }));
    expect(selectUsageRankedLeaders(tied, 2, 'auto').map(entry => entry.key)).toEqual(['a', 'b']);
    expect(selectUsageRankedLeaders(tied, 0, 'auto')).toEqual([]);
    expect(selectUsageRankedLeaders(tied, 10, 'auto').map(entry => entry.key)).toEqual(['a', 'b', 'z']);
});

it('matches full ranking order across token, money, event and key boundaries for every existing cost mode', () => {
    const entries = Array.from({ length: 257 }, (_, index) => ({ key: `key-${index}`, eventCount: index % 3,
        tokens: { ...contribution.tokens, total: (index * 13) % 7 },
        cost: { ...contribution.cost, reportedUsd: (index * 31) % 11, estimatedUsd: index % 5,
            apiEquivalentUsd: index % 9, costSource: 'provider_reported' as const },
    }));
    for (const mode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
        const ranked = [...entries].sort((left, right) => compareUsageRankedLeaders(left, right, mode));
        for (const limit of [0, 1, 3, 20, 257, 300]) expect(selectUsageRankedLeaders(entries, limit, mode)).toEqual(ranked.slice(0, limit));
    }
});

it('groups compact timeline source metadata without folding discarded monetary totals', () => {
    for (const count of [1, 128]) {
        let costReads = 0;
        const rows = Array.from({ length: count }, (_, index) => ({ ...contribution, eventCount: 2,
            source: index % 2 ? 'native' : 'runtime',
            get cost() { costReads++; return contribution.cost; },
        }));
        const groups = groupUsageLeaderSources(rows);
        expect(groups.flatMap(group => group.rows)).toHaveLength(count);
        expect(groups.reduce((sum, group) => sum + group.value.eventCount, 0)).toBe(count * 2);
        expect(groups.reduce((sum, group) => sum + group.value.tokens.total, 0)).toBe(count);
        expect(costReads, 'metadata admission has no monetary output to calculate').toBe(0);
        const rich = buildUsageLeaderList(rows, 'model', 1, 'auto', new Map(), true)![0]!.sources!;
        expect(costReads, 'rich source money still folds its actual monetary population').toBeGreaterThan(0);
        expect(groups.map(group => group.value).sort((a, b) => a.source.localeCompare(b.source)))
            .toEqual(rich.map(({ cost: _cost, ...metadata }) => metadata));
    }
});

it('admits compact ranking operands without pricing the selected population a second time', () => {
    let costReads = 0;
    const rows = [10, 9, 9, 9, 1].map((total, index) => ({ ...contribution,
        sessionId: String(index), eventCount: 1, tokens: { ...contribution.tokens, total },
        get cost() { costReads++; return contribution.cost; },
    }));
    const selected = selectUsageLeaderTokenFrontier(rows, 'session', 2);
    expect(selected.map(group => group.value.key)).toEqual(['0', '1', '2', '3']);
    expect(selected.map(group => group.rows[0])).toEqual(rows.slice(0, 4));
    expect(costReads, 'a compact pricing population needs token admission, not another monetary projection').toBe(0);
});

it('prices only the token frontier while keeping monetary tie ordering and newly requested candidates', () => {
    const priced = new Set<number>();
    // The QA Account has 2,733 Sessions; price cannot promote a lower token count.
    const rows = Array.from({ length: 2733 }, (_, index) => ({ ...contribution,
        id: String(index), sessionId: String(index), eventCount: 1,
        tokens: { ...contribution.tokens, input: index < 4 ? 100 : 1, total: index < 4 ? 100 : 1 },
        get cost() {
            priced.add(index);
            return { reportedUsd: index / 10, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
        },
    }));
    const leaders = buildUsageLeaderList(rows, 'session', 3, 'auto');
    expect(leaders?.map(leader => leader.key)).toEqual(['3', '2', '1']);
    expect([...priced].sort((a, b) => a - b), 'a lower token count cannot enter this ranking, regardless of its money').toEqual([0, 1, 2, 3]);
    priced.clear();
    const expanded = buildUsageLeaderList(rows, 'session', rows.length, 'auto');
    expect(expanded).toHaveLength(rows.length);
    expect(priced.size).toBe(rows.length);
    expect(expanded?.slice(0, 3)).toEqual(leaders);
});

it('retains every token-frontier tie for compact private repricing', () => {
    const rows = [10, 9, 9, 9, 1].map((total, index) => ({ ...contribution,
        id: String(index), sessionId: String(index), eventCount: 1,
        tokens: { ...contribution.tokens, input: total, total },
        cost: { ...contribution.cost, reportedUsd: index / 10, costSource: 'provider_reported' as const },
    }));
    const result = selectUsageLeaderTokenFrontier(rows, 'session', 2);
    expect(result.map(group => group.value.key)).toEqual(['0', '1', '2', '3']);
    expect(buildUsageLeaderList(rows, 'session', 2, 'auto')?.map(leader => leader.key)).toEqual(['0', '3']);
});

it('preserves half-open, overlapping and empty chart ranges with exact monetary additions', () => {
    const contributions = [4, 1, 2, 3].map((observedAtMs, index) => ({ ...contribution,
        id: String(index), observedAtMs, eventCount: 1,
        cost: { ...contribution.cost, reportedUsd: index === 0 ? 1e16 : 1, costSource: 'provider_reported' as const },
    }));
    const series = [[0, 10], [2, 5], [4, 4], [3, 4], [100, 101], [4, 5], [0, 10]].map(([bucketStartMs, bucketEndMs]) => ({
        bucketStartMs: bucketStartMs!, bucketEndMs: bucketEndMs!, eventCount: 4,
        tokens: contribution.tokens, cost: contribution.cost,
    }));
    const response = { v: 1 as const, totals: { eventCount: 4, tokens: contribution.tokens, cost: contribution.cost },
        contributions, series };
    const result = projectUsagePageCost(response, 'reported');
    expect(result.accounting.contributions).toBe(contributions);
    // Owner ruling 2026-10-31 L0 corrects IEEE-order boundaries in the shared exact baseline.
    expect(result.accounting.series!.map(bucket => bucket.cost.effectiveUsd))
        .toEqual([1e16 + 4, 1e16 + 2, undefined, 1, undefined, 1e16, 1e16 + 4]);
    expect(result.amountUsd).toBe(1e16 + 4);
    const changed = projectUsagePageCost({ ...response,
        contributions: contributions.map((row, index) => index === 0 ? { ...row, observedAtMs: 1 } : row),
    }, 'reported');
    expect(changed.accounting.series!.map(bucket => bucket.cost.effectiveUsd))
        .toEqual([1e16 + 4, 2, undefined, 1, undefined, undefined, 1e16 + 4]);
});

it('ranks counted contributions without copying their unrelated evidence fields', () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...contribution, id: String(index), eventCount: 1,
        cost: { ...contribution.cost, reportedUsd: 1, costSource: 'provider_reported' as const } }));
    let unrelatedReads = 0;
    for (const row of rows) Object.defineProperty(row, 'context', { enumerable: true, get() { unrelatedReads++; return undefined; } });
    const result = projectUsagePageCost({ v: 1, totals: { eventCount: rows.length, tokens: contribution.tokens, cost: rows[0]!.cost },
        contributions: rows, leaders: { models: [{ key: 'model', eventCount: rows.length, tokens: contribution.tokens, cost: rows[0]!.cost }] } }, 'auto');
    expect(result.accounting.leaders?.models?.[0]).toMatchObject({ key: 'model', eventCount: 100, cost: { effectiveUsd: 100 } });
    expect(unrelatedReads).toBe(0);
});

it('buckets the same selected Claude money as the breakdown across a midnight-spanning reported total', () => {
    // QA-LIVE-17's null Oct 11 day; the full QA-LIVE-11 capture exposes the
    // cross-midnight report witness. IDs are anonymized; clocks/money are real.
    const start = 1791669600000;
    const midnight = 1791756000000;
    const tokens = { ...contribution.tokens, input: 24315, total: 24315 };
    const estimated = { reportedUsd: 0, estimatedUsd: 0.0300936, currency: 'USD', costSource: 'pricing_estimate' as const };
    const rows = [
        { ...contribution, id: 'covered', agentId: 'claude', modelId: 'not-in-catalog', eventCount: 1,
            observedAtMs: 1791742621323, tokens, cost: { ...estimated, reportedTotalId: 'final' } },
        { ...contribution, id: 'estimated', agentId: 'claude', modelId: 'not-in-catalog', eventCount: 1,
            observedAtMs: 1791742623410, tokens, cost: estimated },
        { ...contribution, id: 'final', agentId: 'claude', modelId: null, eventCount: 1,
            observedAtMs: 1791764104404, tokens: { ...tokens, input: 0, total: 0 },
            cost: { reportedUsd: 0.138759, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const,
                reportedTotalContributionIds: ['covered'] } },
    ];
    const raw = { eventCount: 3, tokens, cost: { ...estimated, reportedUsd: 0.138759 } };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: raw, contributions: rows,
        breakdowns: { agent: [{ key: 'claude', ...raw }] },
        series: [start, midnight].map(bucketStartMs => ({ ...raw, bucketStartMs, bucketEndMs: bucketStartMs + 86400000 })),
        engineTimeline: [start, midnight].map(bucketStartMs => ({ bucketStartMs, bucketEndMs: bucketStartMs + 86400000,
            leaders: [{ key: 'claude', ...raw }] })),
    });
    const repriced = repriceUsageAnalyticsResponse(response);
    const page = projectUsagePageCost(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(repriced))), 'auto');
    const days = page.accounting.engineTimeline!.map(bucket => resolveUsageCostForSelection(bucket.leaders[0]!.cost!, page.selection));
    expect(days).toEqual([0.0300936, 0.138759]);
    expect(page.accounting.series!.map(bucket => resolveUsageCostForSelection(bucket.cost, page.selection))).toEqual(days);
    expect(days.reduce<number>((sum, value) => sum + value!, 0)).toBeCloseTo(page.amountUsd!);
    expect(resolveUsageCostForSelection(page.accounting.breakdowns!.agent![0]!.cost, page.selection)).toBeCloseTo(page.amountUsd!);
    // Bucketing does not relabel the covered inference as a second charge.
    expect(page.accounting.contributions).toEqual(UsageAnalyticsQueryResponseSchema.parse(repriced).contributions);
    const dayQuery = projectUsagePageCost({ ...repriced,
        contributions: repriced.contributions!.filter(row => row.observedAtMs < midnight) }, 'auto');
    expect(dayQuery.amountUsd, 'a new day-scoped query cannot attribute the absent report').toBeNull();
});

it('uses one model identity for the real QA snapshot, alias and newer Haiku generation before ranking', () => {
    // Token amounts and model ids from the QA usage.query model ranking, 2026-10-11.
    const rows = [['claude-haiku-4-5-20251001', 2401080, 92], ['claude-haiku-4-5', 372302, 16],
        ['claude-haiku-5-5', 299832, 18]] as const;
    const ranking = buildUsageBreakdownList(rows.map(([modelId, total, eventCount]) => ({ ...contribution,
        modelId, eventCount, tokens: { ...contribution.tokens, input: total, total } })), 'model', 20, 'auto');
    expect(ranking.map(row => [row.key, row.tokens.total, row.eventCount])).toEqual([
        ['claude-haiku-4-5', 2773382, 108], ['claude-haiku-5-5', 299832, 18],
    ]);
});

it('retains source partitions and re-prices each partition from its own admitted contributions', () => {
    const tokens = { ...contribution.tokens, input: 1_000_000, total: 1_000_000 };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 2, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 }, cost: contribution.cost },
        engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 100, leaders: [{ key: 'agent', eventCount: 2, tokens, cost: contribution.cost }] }],
        contributions: [
            { ...contribution, id: 'inside', eventCount: 1, tokens, sourceContext: { path: 'runtime', execution: 'happier' } },
            { ...contribution, id: 'outside', eventCount: 1, tokens, source: 'native', sourceContext: { path: 'native', execution: 'outside' } },
        ],
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1, models: { model: { inputUsdPerMillion: 2, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'source', fetchStatus: 'ready' } },
        { model: { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 1 } }, 'api_equivalent');
    expect(result.engineTimeline?.[0]?.leaders[0]).toMatchObject({ tokens: { total: 2_000_000 }, cost: { apiEquivalentUsd: 6 }, sources: [
        { source: 'native', path: 'native', execution: 'outside', tokens: { total: 1_000_000 }, cost: { apiEquivalentUsd: 3 } },
        { source: 'runtime', path: 'runtime', execution: 'happier', tokens: { total: 1_000_000 }, cost: { apiEquivalentUsd: 3 } },
    ] });
});

it('admits witnessed contribution event counts while retaining older missing counts', () => {
    expect(UsageAnalyticsContributionSchema.parse({ ...contribution, eventCount: 3, context: { usedTokens: 15, windowTokens: 100 } })).toMatchObject({ eventCount: 3, context: { usedTokens: 15, windowTokens: 100 } });
    expect(UsageAnalyticsContributionSchema.parse(contribution).eventCount).toBeUndefined();
    expect(UsageAnalyticsContributionSchema.safeParse({ ...contribution, eventCount: -1 }).success).toBe(false);
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: contribution.tokens, cost: contribution.cost },
        contributions: [{ ...contribution, eventCount: 3 }],
        coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [],
            range: { complete: true }, ranked: [] },
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1,
        models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'witnessed', fetchStatus: 'ready' },
    }, {}, 'api_equivalent');
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent'))
        .toMatchObject({ eventCount: 3, complete: true });
});

it('recovers a server-omitted token-tied winner after a private price override', () => {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 7, costSource: 'pricing_estimate', currency: 'USD' };
    const leader = { key: 'a-model', label: 'a-model', eventCount: 2, tokens, cost };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 5, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 }, cost },
        leaders: { models: [leader] }, breakdowns: { model: [leader] }, modelTimeline: [{ bucketStartMs: 0, bucketEndMs: 100, leaders: [leader] }],
        contributions: ['a-model', 'z-model'].map(modelId => ({ id: modelId, observedAtMs: 1, sessionId: 'session', turnId: null,
            agentId: 'agent', backendMode: null, modelId, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
            tokens, tokenCategories: tokens, cost })),
    });
    const admitted = { ...response, contributions: response.contributions!.map((row, index) => ({ ...row, eventCount: index === 0 ? 2 : 3,
        context: { usedTokens: index === 0 ? 5 : 15, windowTokens: 100 } })) };
    const result = repriceUsageAnalyticsResponse(admitted, {
        v: 1, models: { 'a-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 }, 'z-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 3 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
    }, { 'z-model': { kind: 'rates', inputUsdPerMillion: 10, outputUsdPerMillion: 3 } }, 'api_equivalent');
    expect(result.leaders?.models).toEqual([expect.objectContaining({ key: 'z-model', label: 'z-model', eventCount: 3,
        cost: expect.objectContaining({ apiEquivalentUsd: 10, effectiveUsd: 10 }) })]);
    expect(result.modelTimeline?.[0]?.leaders[0]?.key).toBe('z-model');
    expect(result.breakdowns?.model?.[0]).toMatchObject({ key: 'z-model', context: { usedTokens: 15, windowTokens: 100 } });
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent' && fact.source.includes('user:'))?.eventCount).toBe(3);
});

it('retains older rankings honestly when missing event counts prevent reconstructing ties', () => {
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: contribution.tokens, cost: contribution.cost },
        contributions: [contribution], leaders: { models: [{ key: 'model', label: 'preserved label', eventCount: 3,
            tokens: contribution.tokens, cost: contribution.cost }] },
        coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], range: { complete: true },
            ranked: [{ dimension: 'model', totalEntries: 1, returnedEntries: 1, complete: true }] },
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1, models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' } }, {}, 'api_equivalent');
    expect(result.leaders?.models?.[0]).toMatchObject({ key: 'model', label: 'preserved label', eventCount: 3 });
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['ranked_truncation'], ranked: [{ complete: false }] });
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent'))
        .toMatchObject({ eventCount: 1, complete: false });
});

it('re-prices a retained snapshot-key ranking without inventing missing legacy event counts', () => {
    const modelId = 'claude-haiku-4-5-20251001';
    const tokens = { ...contribution.tokens, input: 1_000_000, total: 1_000_000 };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens, cost: contribution.cost },
        contributions: [{ ...contribution, modelId, tokens }],
        breakdowns: { model: [{ key: modelId, eventCount: 3, tokens, cost: contribution.cost }] },
        leaders: { models: [{ key: modelId, eventCount: 3, tokens, cost: contribution.cost }] },
    });
    const result = repriceUsageAnalyticsResponse(response, {
        v: 1, models: { 'claude-haiku-4-5': { inputUsdPerMillion: 2, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
    }, {}, 'api_equivalent');
    expect(result.breakdowns?.model?.[0]).toMatchObject({ key: modelId, eventCount: 3, cost: { apiEquivalentUsd: 2 } });
    expect(result.leaders?.models?.[0]).toMatchObject({ key: modelId, eventCount: 3, cost: { apiEquivalentUsd: 2 } });
});

it('partitions legacy contributions once per ranked surface instead of rescanning for every candidate', () => {
    const count = 600;
    const cost = { ...contribution.cost, reportedUsd: 1, costSource: 'provider_reported' as const };
    const entries = Array.from({ length: count }, (_, index) => ({ key: `model-${index}`, eventCount: 1,
        tokens: contribution.tokens, cost }));
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: count, tokens: { ...contribution.tokens, input: count, total: count }, cost },
        contributions: entries.map(entry => ({ ...contribution, id: entry.key, modelId: entry.key, cost })),
        leaders: { models: entries }, breakdowns: { model: entries },
    });
    let dimensionReads = 0;
    for (const row of response.contributions!) {
        const modelId = row.modelId;
        Object.defineProperty(row, 'modelId', { enumerable: true, get() { dimensionReads++; return modelId; } });
    }
    const page = projectUsagePageCost(response, 'auto');
    expect(page.amountUsd).toBe(count);
    expect(page.accounting.leaders?.models?.map(entry => [entry.key, entry.eventCount, entry.cost?.effectiveUsd]))
        .toEqual(entries.map(entry => [entry.key, 1, 1]));
    expect(page.accounting.breakdowns?.model?.map(entry => [entry.key, entry.eventCount, entry.cost.effectiveUsd]))
        .toEqual(entries.map(entry => [entry.key, 1, 1]));
    // Two separately projected surfaces each need one pass over the population.
    // Count real row reads rather than imposing a machine-dependent wall-clock budget.
    expect(dimensionReads).toBeLessThanOrEqual(count * 2);
});
