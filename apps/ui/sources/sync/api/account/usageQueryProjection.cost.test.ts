import { afterEach, expect, it, vi } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectUsageQueryBatch } from './usageQueryProjection';

afterEach(() => vi.restoreAllMocks());

it('does zero reprojections for value-equal push inputs and projects only a genuinely changed member', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    const queries = ['first', 'second'].map(agent => normalizeUsageQuery({ agents: [agent],
        period: { startMs: 1000, endMs: 2000 }, includeContributions: true, includeComparison: false,
        includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: true, includeActivity: false }));
    const visits = [0, 0];
    type Input = Parameters<typeof projectUsageQueryBatch>[0];
    const accounting: Input['accounting'] = new Map(queries.map((query, index) => [getUsageQueryKey(query), {
        query, status: 'available', asOfMs: 2000, value: { v: 1,
            get totals() { visits[index]!++; return { eventCount: index + 1,
                tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
                cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } }; }, contributions: [] },
    }]));
    let input: Input = { context: { accountLifetime: { scope: { serverId: 'projection-cost', accountId: 'a' },
        isCurrent: () => true, onRetire: () => ({ dispose() {} }) } }, queries, accountingNowMs: 2000, accounting,
        prepareAccounting: (snapshot, prepare) => prepare(snapshot), priorAccounting: new Map(), calendarQueryKeys: new Set(),
        previous: undefined, admittedPrevious: undefined, work: queries.map(query => ({ query, status: 'pending' })),
        howYouWork: undefined, howYouWorkSourcesByQuery: new Map(), settledHowYouWorkQueries: new Set(), evidenceQueries: [],
        quota: { status: 'not_loaded' }, pools: [], priorSlices: new Map(), mcpCatalog: undefined, sourceLocations: [] };
    const run = () => {
        const batch = projectUsageQueryBatch(input);
        input = { ...input, admittedPrevious: batch };
        return batch;
    };
    run(); run();
    const before = run();
    let sourcePasses = 0;
    const work = new Proxy(input.work.map(snapshot => ({ ...snapshot, query: { ...snapshot.query } })), {
        get(target, property, receiver) {
            if (property === 'map') sourcePasses++;
            return Reflect.get(target, property, receiver);
        },
    });
    input = { ...input, queries: queries.map(query => ({ ...query, agents: [...query.agents] })),
        work, quota: { ...input.quota } };
    visits.fill(0);
    expect(run()).toBe(before);
    // Admission indexes the supplied snapshots once. Entering aggregation or
    // profile-evidence projection would walk this source collection again.
    expect(sourcePasses, 'equal push inputs require admission only, with zero projection passes').toBe(1);
    expect(visits, 'equal push inputs must not revisit either accounting population').toEqual([0, 0]);
    input = { ...input, work: [{ query: queries[0]!, status: 'unsupported', errorCode: 'NOT_REPOSITORY' }, input.work[1]!] };
    visits.fill(0);
    const changed = run();
    expect(changed.results[0]?.sources.find(source => source.source === 'work')?.status).toBe('unsupported');
    expect(changed.results[1]).toBe(before.results[1]);
    expect(visits[1], 'a changed member must not reproject the retained sibling').toBe(0);
});
