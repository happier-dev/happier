import { afterEach, expect, it, vi } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageComparisonQuery, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageCoachSuppressionStateV1Schema } from '@happier-dev/protocol/usage/coach/coachActions';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
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
    const fresh = () => projectUsageQueryBatch({ ...oracleInput, accounting: new Map(oracleInput.accounting) });
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
    expect(retained.results[0]?.coach?.currentness, 'pending private replacement preserves the canonical retained-Coach transition').toBe('stale');
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
