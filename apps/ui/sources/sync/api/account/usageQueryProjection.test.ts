import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { afterEach, expect, it, vi } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation, resolveUsageComparisonQuery, UsageQueryBatchResultSchema, type UsageQuerySourceState, type UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistorySchemasV1';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { UsageCoachSuppressionStateV1Schema } from '@happier-dev/protocol/usage/coach/coachActions';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup, createSessionFixture } from '@/dev/testkit';
import { projectUsageQueryWorkEvidence, projectUsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { projectUsageQueryBatch, type PreparedUsageAccountingSnapshot } from './usageQueryProjection';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; vi.restoreAllMocks();
});

async function fixture() {
    vi.spyOn(Date, 'now').mockReturnValue(2000);
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-slice-progress.test', accountId: 'account-a' }],
        route: () => undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const context = { accountLifetime: captureActiveServerAccountScopeLifetime()! };
    expect(context.accountLifetime?.isCurrent()).toBe(true);
    storage.setState({ settingsScope: context.accountLifetime.scope, settings: settingsDefaults });
    const queries = ['first', 'second'].map(agent => normalizeUsageQuery({ agents: [agent], period: { startMs: 1000, endMs: 2000 },
        includeContributions: true, includeSessionEvidence: true, includeTranscriptEvidence: false, includeWorkEvidence: true,
        includeComparison: true, includeActivity: true }));
    const visits = [0, 0];
    const workVisits = [0, 0];
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    const priceCatalog = { v: 1 as const, models: {}, provenance: { source: 'litellm' as const, origin: 'bundled' as const,
        asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' as const } };
    const accounting = new Map<string, PreparedUsageAccountingSnapshot>();
    for (const [index, query] of queries.entries()) {
        const totals = { eventCount: index + 1, tokens, cost };
        accounting.set(getUsageQueryKey(query), { query, status: 'available', asOfMs: 2000,
            value: { v: 1, get totals() { visits[index]!++; return totals; }, contributions: [], priceCatalog } });
        const compared = resolveUsageComparisonQuery(query)!;
        accounting.set(getUsageQueryKey(compared), { query: compared, status: 'available', asOfMs: 1000,
            value: { v: 1, totals, contributions: [], priceCatalog } });
    }
    let input: Parameters<typeof projectUsageQueryBatch>[0] = { context, queries, accountingNowMs: 2000, accounting,
        prepareAccounting(snapshot, prepare) { return prepare(snapshot); },
        priorAccounting: new Map(), calendarQueryKeys: new Set(queries.map(getUsageQueryKey)), previous: undefined, admittedPrevious: undefined,
        work: queries.map((query, index) => ({ query, get status() { workVisits[index]!++; return 'pending' as const; } })), howYouWork: undefined,
        howYouWorkSourcesByQuery: new Map(), settledHowYouWorkQueries: new Set(), evidenceQueries: queries,
        coachSuppressions: UsageCoachSuppressionStateV1Schema.parse({ v: 1, suppressions: [] }),
        quota: { status: 'not_loaded' }, pools: [], priorSlices: new Map(), mcpCatalog: undefined, sourceLocations: [] };
    let oracleInput = input;
    const run = () => {
        oracleInput = { ...input, accounting: new Map(input.accounting) };
        const batch = projectUsageQueryBatch(input);
        input = { ...input, admittedPrevious: batch };
        return batch;
    };
    const fresh = () => projectUsageQueryBatch({ ...oracleInput, admittedPrevious: undefined, accounting: new Map(oracleInput.accounting) });
    return { queries, visits, workVisits, run, fresh, input: () => input,
        update(change: Partial<typeof input>) { input = { ...input, ...change }; },
        reset() { visits.fill(0); workVisits.fill(0); } };
}

function difference(actual: unknown, expected: unknown, path = '$'): string | undefined {
    if (Object.is(actual, expected)) return undefined;
    if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return path;
    const actualEntries = new Map(Object.entries(actual));
    const expectedEntries = new Map(Object.entries(expected));
    if (actualEntries.size !== expectedEntries.size) return `${path} keys ${[...actualEntries.keys()]} / ${[...expectedEntries.keys()]}`;
    for (const [key, value] of actualEntries) {
        if (!expectedEntries.has(key)) return `${path}.${key} missing`;
        const changed = difference(value, expectedEntries.get(key), `${path}.${key}`);
        if (changed) return changed;
    }
    return undefined;
}
function expectParity(actual: unknown, expected: unknown) {
    // Compare every transported member without dumping full accounting catalogs on failure.
    expect(difference(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)))).toBeUndefined();
}

it('does zero population projection for unchanged progress and only projects the changed query', async () => {
    const f = await fixture();
    const initial = f.run();
    const retained = f.run();
    expect(initial.results[0]?.coach?.currentness).toBe('current');
    expect(retained.results[0]?.coach?.currentness, 'publishing the same read is not a private replacement').toBe('current');
    expect(retained).toBe(initial);
    const first = f.run();
    expect(first).toBe(retained);
    f.reset();
    const unchanged = f.run();
    expect(f.workVisits, 'unchanged progress must not enter either query’s Work projection').toEqual([0, 0]);
    expect(f.visits, 'unchanged progress must not traverse either admitted accounting population').toEqual([0, 0]);
    expect(unchanged).toBe(first);
    f.update({ work: [{ query: f.queries[0]!, status: 'unsupported', errorCode: 'NOT_REPOSITORY' }, f.input().work[1]!] });
    f.reset();
    const changed = f.run();
    expect(changed.results[0]?.sources.find(source => source.source === 'work')?.status).toBe('unsupported');
    expect(changed.results[1]).toBe(first.results[1]);
    expect(f.workVisits[1], 'a sibling Work settlement must not enter this query’s Work projection').toBe(0);
    expect(f.visits[1], 'a sibling Work settlement must not project this accounting population').toBe(0);
    expectParity(changed, f.fresh());
});

it('retains Coach as stale when a new finite read replaces its private evidence', async () => {
    const f = await fixture();
    const previous = f.run();
    const replacement = projectUsageQueryBatch({ ...f.input(), accounting: new Map(f.input().accounting),
        previous, admittedPrevious: undefined });
    expect(replacement.results[0]?.coach?.currentness).toBe('stale');
});

it('keeps the last failed source verdict while its background replacement is pending', async () => {
    const f = await fixture();
    const initial = f.run();
    const previous = { ...initial, results: initial.results.map(slice => ({ ...slice,
        sources: slice.sources.map(source => source.source === 'how_you_work'
            ? { ...source, status: 'stale' as const, asOfMs: 2000, errorCode: 'usage_query_failed' } : source) })) };
    const replacement = projectUsageQueryBatch({ ...f.input(), previous, admittedPrevious: undefined,
        priorSlices: new Map(previous.results.map(slice => [slice.key, slice])) });
    for (const slice of replacement.results) {
        expect(slice.pending, 'the read itself remains visibly in flight').toBe(true);
        expect(slice.sources.find(source => source.source === 'how_you_work')).toMatchObject({
            status: 'stale', asOfMs: 2000, errorCode: 'usage_query_failed',
        });
    }
});

it('updates replacements, comparison, staged evidence, quota, labels and consumed settings like a fresh projection', async () => {
    const f = await fixture();
    f.run();
    const check = (change: Partial<Parameters<typeof projectUsageQueryBatch>[0]>) => {
        f.update(change);
        const next = f.run();
        expectParity(next, f.fresh());
        return next;
    };
    const key = getUsageQueryKey(f.queries[0]!);
    const snapshot = f.input().accounting.get(key)!;
    f.input().accounting.set(key, { ...snapshot, asOfMs: 2100, value: { ...snapshot.value!, totals: {
        ...snapshot.value!.totals, eventCount: 20 } } });
    expect(check({}).results[0]?.accounting?.totals.eventCount).toBe(20);
    const comparisonKey = getUsageQueryKey(resolveUsageComparisonQuery(f.queries[0]!)!);
    const comparison = f.input().accounting.get(comparisonKey)!;
    f.input().accounting.set(comparisonKey, { ...comparison, value: { ...comparison.value!, totals: {
        ...comparison.value!.totals, eventCount: 30 } } });
    expect(check({}).results[0]?.comparison?.accounting?.totals.eventCount).toBe(30);
    const staged = new Map<string, readonly UsageQuerySourceState[]>([[key, [{ source: 'sessions', status: 'pending' }]]]);
    check({ howYouWorkSourcesByQuery: staged });
    staged.set(key, [{ source: 'sessions', status: 'available' }]);
    check({ settledHowYouWorkQueries: new Set([key]), howYouWork: [{ query: f.queries[0]!, errorCode: 'feature_unsupported' }] });
    expect(check({ quota: { status: 'available', value: [], asOfMs: 2200 } }).results.every(slice =>
        slice.sources.find(source => source.source === 'quota')?.status === 'available')).toBe(true);
    check({ sourceLocations: [{ machineId: 'machine-a', displayLocation: 'Current machine' }] });
    storage.setState({ settings: { ...settingsDefaults, usageNightHoursV1: { startHour: 22, endHour: 6 } } });
    check({});
    storage.setState({ settings: { ...storage.getState().settings, usageModelPriceOverridesV1: { custom: { kind: 'rates', inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } });
    check({});
});


it('keeps the mixed-batch projection path when only its quota member changes', async () => {
    const f = await fixture();
    const quotaQuery = normalizeUsageQuery({ ...f.queries[1]!, includeAccounting: false, includeComparison: false,
        includeContributions: false, includeSessionEvidence: false, includeWorkEvidence: false, includeActivity: false });
    f.update({ queries: [f.queries[0]!, quotaQuery] });
    f.run(); f.run();
    const before = f.run();
    f.update({ pools: [{ query: quotaQuery, value: [] }] });
    const changed = f.run();
    expect(changed.results[0]).toBe(before.results[0]);
    expectParity(changed, f.fresh());
});

it('keeps every Usage view and Coach consistent through the UI read model and Action dispatch at realistic scale', async () => {
    const f = await fixture();
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeCoach: true,
        includeSessionEvidence: true, includeWorkEvidence: true, includeTranscriptEvidence: true,
        includeComparison: true, includeQuota: true, includeActivity: true, timeZoneOffsetMinutes: 0 });
    // Keep the Coach-only demand that exposed b67931869cc8's compaction bug.
    const coachQuery = normalizeUsageQuery({ ...query, includeWorkEvidence: false, includeComparison: false, includeQuota: false });
    const summaryQuery = normalizeUsageQuery({ ...query, includeCoach: false, includeWorkEvidence: false,
        includeSessionEvidence: false, includeTranscriptEvidence: false });
    const privateQuery = normalizeUsageQuery({ ...query, includeCoach: false, includeWorkEvidence: false, includeQuota: false });
    const queries = [query, coachQuery, summaryQuery, privateQuery];
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, apiEquivalentUsd: 1, currency: 'USD' };
    const refs = ['one', 'two'].map(accountId => ({ service: { pluginId: 'test.provider', localId: 'subscription' }, accountId }));
    const contributions = Array.from({ length: 2_077 }, (_, index) => ({ id: `reading-${index}`, observedAtMs: 1500,
        sessionId: `session-${index % 142}`, turnId: `turn-${index % 142}`, modelId: 'claude-haiku-4-5',
        agentId: index % 2 ? 'codex' : 'claude', machineId: 'machine', projectKey: 'project', workspaceId: null,
        source: 'runtime', eventCount: 1, tokens, tokenCategories: tokens, cost,
        providerAttribution: 'known', connectedAccount: refs[index % 2] }));
    const value = repriceUsageAnalyticsResponse(UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 2_077, tokens: { ...tokens, input: 20_770, output: 10_385, total: 31_155 },
            cost: { ...cost, reportedUsd: 2_077, apiEquivalentUsd: 2_077 } }, contributions,
        coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
            range: { startMs: 1000, endMs: 2000, complete: false },
            sources: Array.from({ length: 288 }, (_, index) => ({ source: `source-${index}`, path: 'runtime',
                status: index === 0 ? 'unknown' : 'partial', eventCount: 1, historyComplete: false })) },
        activity: { calendarDays: [{ date: '1970-01-01', eventCount: 2_077 }], weekdayHourBuckets: [{ weekday: 4, hour: 0, eventCount: 2_077 }] },
    }), bundledUsageModelPriceCatalog);
    const comparedValue = UsageAnalyticsQueryResponseSchema.parse({ ...value, contributions: [], costFacts: [],
            totals: { ...value.totals, eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
            coverage: { ...value.coverage!, range: { startMs: 0, endMs: 1000, complete: false } } });
    const accounting = [...queries.map(query => ({ query, value, status: 'available' as const, asOfMs: 2000 })),
        ...new Map(queries.flatMap(query => {
            const compared = resolveUsageComparisonQuery(query);
            return compared ? [[getUsageQueryKey(compared), { query: compared, value: comparedValue, status: 'available' as const, asOfMs: 1000 }] as const] : [];
        })).values()];
    const scope = f.input().context.accountLifetime.scope;
    const sessions = Array.from({ length: 142 }, (_, index) => projectUsageSessionInput(createSessionFixture({
        id: `session-${index}`, serverId: scope.serverId, metadata: { path: 'project', host: '', machineId: 'machine' },
        sessionTurns: { v: 1, sessionId: `session-${index}`, updatedAt: 1400, turns: [{ turnId: `turn-${index}`,
            agentId: index % 2 ? 'codex' : 'claude', status: index === 0 ? 'failed' : 'completed',
            startedAt: index === 0 ? 1400 : 1100, terminalAt: 1400, updatedAt: 1400 }] },
    })));
    const howYouWork = queries.filter(query => query.includeSessionEvidence).map(query => ({ query, asOfMs: 2000, sessions,
        sessionCoverage: { selected: 142, admitted: 142 },
        detail: projectUsageQueryWorkEvidence({ query, scope, currentScope: scope, isCurrent: true, sessions,
            contributions: value.contributions, openedMessages: new Map() }) }));
    const quota = { status: 'available' as const, asOfMs: 2000, value: refs.map(ref => {
        const recordKey = { providerId: 'provider', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
        return ConnectedServiceQuotaGetResultV1Schema.parse({ source: { ref, bindingKind: 'account' },
            current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'provider',
                accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: 1500, fetchedAtMs: 1500,
                staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] },
            pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' } });
    }) };
    const work = [{ query, evidence: [], status: 'available' as const, asOfMs: 2000 }];
    f.update({ queries, accounting: new Map(accounting.map(row => [getUsageQueryKey(row.query), row])), work, howYouWork,
        quota, evidenceQueries: howYouWork.map(row => row.query), settledHowYouWorkQueries: new Set(howYouWork.map(row => getUsageQueryKey(row.query))),
        calendarQueryKeys: new Set(queries.map(getUsageQueryKey)) });
    const ui = f.run();
    // Substitute only authenticated transport, keeping Action admission,
    // aggregation, strict result validation and CLI delivery real.
    const executor = createActionExecutor({ usageActions: { query: async () => resolveUsagePageAggregation({
        queries, accounting, work, howYouWork, quota, nowMs: 2000,
        accountSettings: settingsDefaults, coachPreferences: settingsDefaults.usageCoachPreferencesV1,
    }, bundledUsageModelPriceCatalog) } } as ActionExecutorDeps);
    const dispatched = await executor.execute('usage.query', { queries }, { surface: 'cli' });
    if (!dispatched.ok) throw new Error(`Usage Action refused: ${dispatched.errorCode}`);
    const action = UsageQueryBatchResultSchema.parse(dispatched.result);
    const facts = (slices: readonly UsageQueryResultSlice[]) => {
        const work = slices[0]!;
        const summary = slices[2]!;
        const privateFacts = slices[3]!;
        return {
            Overview: { totals: summary.accounting?.totals, comparison: summary.comparison?.accounting?.totals },
            Costs: { totals: summary.costFactTotals, cost: summary.accounting?.totals.cost },
            Work: { allocations: work.work, summary: work.workSummary, outcomes: work.mergedOutcomes },
            Plans: { quota: summary.quota, insights: summary.planInsights },
            'How you work': privateFacts.howYouWork,
            Sources: { coverage: summary.accounting?.coverage, states: summary.sources },
            Agents: privateFacts.howYouWork?.agentCalendar,
        };
    };
    const shown = ui.results[0]!;
    const summary = ui.results[2]!;
    const privateFacts = ui.results[3]!;
    // Independent witnesses prevent agreement on absent/default facts passing.
    expect(summary.accounting?.totals.tokens.total).toBe(31_155);
    expect(summary.comparison?.accounting?.totals.tokens.total).toBe(0);
    expect(summary.costFactTotals?.length).toBeGreaterThan(0);
    expect(summary.accounting?.contributions).toBeUndefined();
    expect(shown.workSummary).toMatchObject({ sessionCount: 142, contributionCount: 2_077 });
    expect(shown.work?.allocations.length).toBeGreaterThan(0);
    expect(summary.planInsights?.accounts).toHaveLength(2);
    expect(summary.planInsights?.accounts.every(account => account.value.status === 'available')).toBe(true);
    expect(privateFacts.howYouWork?.intervals?.agentTimeMs).toBe(42_300);
    expect(privateFacts.howYouWork?.permissions).toBeNull();
    expect(privateFacts.howYouWork?.agentCalendar?.periodSummary.agents).toHaveLength(2);
    expect(summary.accounting?.coverage?.sources).toHaveLength(288);
    for (const [view, expected] of Object.entries(facts(action.results))) {
        expect(difference(JSON.parse(JSON.stringify(facts(ui.results)[view as keyof ReturnType<typeof facts>])),
            JSON.parse(JSON.stringify(expected))), `${view} UI/Action facts`).toBeUndefined();
    }
    const uiCoach = ui.results[1]!;
    const actionCoach = action.results[1]!;
    expect(actionCoach.coach?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ detectorId: 'cache_economics' })]));
    expect(uiCoach.coach?.findings).toEqual(actionCoach.coach?.findings);
    expect(uiCoach.accounting?.contributions).toBeUndefined();
});
