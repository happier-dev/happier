import { describe, expect, it, vi } from 'vitest';
import { getUsageAnalyticsQueryRequestKey, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, projectUsagePageCost, resolveUsageCostBasis } from '@happier-dev/protocol/usage/usageCost';
import { projectUsageAnalyticsResponseDemand } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { prepareUsageAnalyticsProjection, projectUsageAnalytics, selectUsageMessageCounts, type UsageAnalyticsSnapshot } from './usageQueryService';
import { projectUsageAnalyticsBatch } from './query/readUsageAnalyticsBatch';
import { projectUsageAnalyticsPopulation, projectUsageAnalyticsPopulationSteps } from './query/projectUsageAnalyticsPopulation';
import { projectUsageAnalyticsDemands } from './query/projectUsageAnalyticsDemands';
import { resolveCapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { UsageQueryTiming } from './query/usageQueryTiming';
import { Session } from 'node:inspector';
import { setImmediate as nextTurn } from 'node:timers/promises';

type CapturedRow = UsageAnalyticsSnapshot['rows'][number];
const subject = { kind: 'native', machineId: 'machine', agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
    sourceRootKey: 'root', nativeSessionKey: 'native', linkedSessionId: 'session' };

// Exact decimal units are numeric quantities encoded as strings, not identities or labels.
const shape = (value: unknown) => JSON.stringify(value, (key, leaf: unknown) =>
    typeof leaf === 'number' ? 0 : key === 'units' && typeof leaf === 'string' ? '0' : leaf);
const existingFacts = (value: unknown): unknown => JSON.parse(JSON.stringify(value,
    (key, leaf: unknown) => key === 'selectedBasis' ? undefined : leaf));

function row(id: string, total: number, metadata: CapturedRow['metadata'], options: Partial<Pick<CapturedRow, 'sessionId' | 'source'>> = {}): CapturedRow {
    return {
        id, sessionId: 'session', observedAt: new Date(100), createdAt: new Date(100), agentId: 'codex',
        backendMode: null, modelId: null, projectKey: null, workspaceId: null, machineId: 'machine',
        source: 'runtime', scope: 'turn_delta', isCumulative: false, turnId: id, externalKey: null, metadata,
        requestCount: 1, teamCredentialResourceId: null, teamCredentialActorAccountId: null,
        teamCredentialExternalApiKeyId: null, teamCredentialSourceCredentialId: null,
        brokerMachineId: null, credentialDeliveryMode: null, inputTokens: total, outputTokens: 0,
        reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: total,
        reportedCostUsd: 0, estimatedCostUsd: 0, invoiceCostUsd: 0, billingContext: null, costSource: null,
        currency: 'USD', costBreakdown: null, contextUsedTokens: null, contextWindowTokens: null, ...options,
    };
}

describe('captured usage query projection', () => {
    it('services an expired host slice during committed metadata normalization', () => {
        const seen = new Set<number>();
        let elapsedMs = 0;
        let sliceStartedAt = 0;
        const rows = Array.from({ length: 128 }, (_, index) => ({ ...row(String(index), 10, null),
            get metadata() {
                if (!seen.has(index)) { seen.add(index); elapsedMs++; }
                return { usageAccounting: { path: 'runtime', historyComplete: true } };
            },
        }));
        const snapshot: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const request = UsageAnalyticsQueryRequestSchema.parse({});
        const steps = projectUsageAnalyticsPopulationSteps(snapshot, request, () => elapsedMs - sliceStartedAt >= 20);
        let next = steps.next();
        expect(next.done).toBe(false);
        expect(seen.size, 'committed normalization must service the host before reading all historical metadata').toBe(20);
        let turns = 0;
        while (!next.done) { turns++; sliceStartedAt = elapsedMs; next = steps.next(); }
        expect(turns).toBe(6);
        expect(JSON.stringify(next.value)).toBe(JSON.stringify(projectUsageAnalyticsPopulation(snapshot, request)));
    });
    it('keeps latest ACP context without billing it or overlapping replayed inference usage', () => {
        const inference = (id: string, time: number, total: number, inferenceId: string): CapturedRow => ({
            ...row(id, total, { usageAccounting: { path: 'runtime', inferenceId } }),
            agentId: 'kimi', source: 'acp-usage-update', observedAt: new Date(time), createdAt: new Date(time),
            externalKey: inferenceId, estimatedCostUsd: total / 1000,
        });
        const context = (id: string, time: number, used: number): CapturedRow => ({
            ...inference(id, time, 0, id), scope: 'session_cumulative', isCumulative: true,
            turnId: null, requestCount: 0, contextUsedTokens: used, contextWindowTokens: 1000,
        });
        const snapshot: UsageAnalyticsSnapshot = {
            rows: [
                inference('first', 100, 100, 'kimi-step:first'),
                context('first-context', 200, 140),
                inference('second', 300, 50, 'kimi-step:second'),
                context('compacted-context', 400, 25),
                inference('replayed-first', 500, 100, 'kimi-step:first'),
            ],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined,
        };
        const result = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({
            granularity: 'day', includeSeries: true, breakdowns: ['session'],
        }));
        expect(result.totals.tokens.total).toBe(150);
        expect(result.totals.cost.estimatedUsd).toBeCloseTo(0.15);
        expect(result.totals.context).toEqual({ usedTokens: 25, windowTokens: 1000 });
        expect(result.series?.reduce((sum, bucket) => sum + bucket.tokens.total, 0)).toBe(150);
        expect(result.breakdowns?.session?.[0]?.context).toEqual({ usedTokens: 25, windowTokens: 1000 });
        expect(result.coverage?.reasons).not.toContain('ambiguous_overlap');
        expect(result.coverage?.reasons).not.toContain('counter_discontinuity');
    });

    it('counts only selected Sessions when message evidence is present and suppresses public or execution cohorts', () => {
        const request = UsageAnalyticsQueryRequestSchema.parse({ includeMessageStats: true, includeInsights: true });
        const selected = ['selected', 'missing'];
        const captured = new Map([['selected', 3], ['unselected', 17]]);
        expect(selectUsageMessageCounts(request, selected, undefined)).toBeUndefined();
        expect(selectUsageMessageCounts(request, selected, captured)).toEqual({ messageCount: 3 });
        expect(selectUsageMessageCounts(request, ['missing'], captured)).toEqual({ messageCount: 0 });
        expect(selectUsageMessageCounts({ ...request, population: 'public_eligible_personal' }, selected, captured)).toBeUndefined();
        expect(selectUsageMessageCounts({ ...request, filters: { execution: 'happier' } }, selected, captured)).toBeUndefined();
    });
    it('admits historical metadata once before projecting distinct ranges in one accounting open', async () => {
        let metadataReads = 0;
        const rows = Array.from({ length: 128 }, (_, index) => ({
            ...row(`history-${index}`, 10, undefined),
            observedAt: new Date(index), createdAt: new Date(index),
            // Observe captured database bodies; the real metadata parsers and accounting fold run below.
            get metadata() {
                metadataReads++;
                return { accountingSubject: subject,
                    usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } };
            },
        }));
        const queries = [[100, 128], [0, 100]].map(([startMs, endMs]) => UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs, endMs }, includeSeries: false, breakdowns: [],
        }));
        const captured: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const batch = await projectUsageAnalyticsBatch({ priceCatalog: captured.priceCatalog,
            snapshots: new Map(queries.map(query => [getUsageAnalyticsQueryRequestKey(query), captured])) }, queries, true);
        expect(batch.results.map(result => 'value' in result ? result.value.totals.tokens.total : null)).toEqual([280, 1000]);
        expect(batch.results.map(result => 'value' in result ? result.value.coverage?.sources[0]?.eventCount : null)).toEqual([128, 100]);
        expect(metadataReads, 'raw historical metadata admission must scale with captured rows, not requested ranges').toBeLessThanOrEqual(2 * rows.length);
    });

    it('releases normalized historical evidence before pricing the shared batch', async () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 },
            includeSeries: false, includeInsights: false, includeActivity: false, includeLeaders: false,
            includeModelTimeline: false, breakdowns: ['machine'] });
        const rows = Array.from({ length: 128 }, (_, index) => ({ ...row(`history-${index}`, 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }),
            observedAt: new Date(index), createdAt: new Date(index) }));
        const snapshot: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const timing = new UsageQueryTiming();
        const measure = timing.measure.bind(timing);
        let historicalEvidence: WeakRef<object> | undefined;
        let evidenceReady: (() => void) | undefined;
        const evidencePrepared = new Promise<void>(resolve => { evidenceReady = resolve; });
        timing.measure = (phase, run) => {
            const value = measure(phase, run);
            if (phase === 'fold' && value && typeof value === 'object') {
                const population: unknown = Reflect.get(value, 'value');
                const evidence: unknown = population && typeof population === 'object'
                    ? Reflect.get(population, 'evidenceRows') : undefined;
                if (Array.isArray(evidence)) {
                    historicalEvidence = new WeakRef(evidence);
                    evidenceReady!();
                }
            }
            return value;
        };
        const pending = projectUsageAnalyticsBatch({ priceCatalog: snapshot.priceCatalog,
            snapshots: new Map([[getUsageAnalyticsQueryRequestKey(query), snapshot]]) }, [query], true, true, timing);
        await Promise.race([evidencePrepared, pending]);
        expect(historicalEvidence).toBeDefined();
        await nextTurn();
        const inspector = new Session();
        inspector.connect();
        try {
            await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage',
                error => error ? reject(error) : resolve()));
        } finally { inspector.disconnect(); }
        const retained = historicalEvidence?.deref() !== undefined;
        const batch = await pending;
        expect(historicalEvidence).toBeDefined();
        expect(retained, 'the live batch cache retains coverage groups rather than normalized historical rows').toBe(false);
        const result = batch.results[0];
        if (!result || !('value' in result)) throw new Error('Expected an admitted accounting answer');
        expect(result.value.totals.tokens.total).toBe(280);
        expect(result.value.coverage?.sources[0]?.eventCount).toBe(128);
    });
    it('admits raw monetary rows independently of the requested rankings', () => {
        const rows = Array.from({ length: 2733 }, (_, index) => ({ ...row(`priced-${index}`, 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
            { sessionId: `session-${index}` }), modelId: 'claude-haiku-4-5' }));
        const snapshot: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 200 },
            includeSeries: false, includeLeaders: true, includeModelTimeline: false,
            breakdowns: ['model', 'session', 'machine'], topLimit: 20 });
        const population = projectUsageAnalyticsPopulation(snapshot, query);
        let rawCostReads = 0;
        for (const contribution of population.totalContributions) {
            const cost = contribution.cost;
            Object.defineProperty(contribution, 'cost', { enumerable: true, get() { rawCostReads++; return cost; } });
        }
        const narrow = { ...query, includeSeries: false, includeLeaders: false, includeModelTimeline: false, breakdowns: [] };
        prepareUsageAnalyticsProjection(snapshot, narrow, bundledUsageModelPriceCatalog, population);
        const admittedReads = rawCostReads;
        rawCostReads = 0;
        const value = prepareUsageAnalyticsProjection(snapshot, query, bundledUsageModelPriceCatalog, population).value;
        expect(value.totals.tokens.total).toBe(27330);
        expect(value.totals.cost.apiEquivalentUsd).toBeGreaterThan(0);
        expect(value.breakdowns?.session).toHaveLength(20);
        expect(value.leaders?.models?.[0]?.cost?.apiEquivalentUsd).toBeGreaterThan(0);
        expect(rawCostReads, 'Output families consume priced rows, without repeating raw monetary admission').toBeLessThanOrEqual(admittedReads);
    });
    it('prices only selected contributions once after historical reconciliation', () => {
        const modelId = 'claude-haiku-4-5';
        let tariffReads = 0;
        const catalog = { ...bundledUsageModelPriceCatalog, models: new Proxy(bundledUsageModelPriceCatalog.models, {
            get(target, key, receiver) {
                if (key === modelId) tariffReads++;
                return Reflect.get(target, key, receiver);
            },
        }) };
        const captured = (id: string, at: number) => ({ ...row(id, 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }),
            observedAt: new Date(at), createdAt: new Date(at), modelId });
        const snapshot: UsageAnalyticsSnapshot = { rows: [captured('historical', 50), captured('selected-a', 150), captured('selected-b', 175)],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 },
            includeSeries: false, includeInsights: false, includeActivity: false, includeLeaders: false, includeModelTimeline: false,
            breakdowns: [] });
        const population = projectUsageAnalyticsPopulation(snapshot, query);
        expect(population.totalContributions).toHaveLength(2);
        expect(population.evidenceRows).toHaveLength(3);
        expect(tariffReads, 'Historical reconciliation and selection must not price rows').toBe(0);
        const result = projectUsageAnalytics(snapshot, query, catalog, population);
        expect(result.totals.tokens.total).toBe(20);
        expect(result.totals.cost.apiEquivalentUsd).toBeGreaterThan(0);
        expect(tariffReads, 'Price lookup stays bounded by selected contributions').toBeGreaterThan(0);
        expect(tariffReads, 'Price lookup stays bounded by selected contributions').toBeLessThanOrEqual(population.totalContributions.length);
    });

    it.each(['insights', 'activity-insights', 'breakdowns', 'reordered-breakdowns'] as const)('borrows the exact compact %s subset selected by the server without walking accounting populations', async demand => {
        const base = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 },
            ...(demand === 'activity-insights' ? { population: 'public_eligible_personal' } : {}),
            includeSeries: false, includeInsights: false, includeActivity: demand === 'insights' || demand === 'activity-insights',
            activityResolution: demand === 'activity-insights' ? 'calendar' : 'both',
            includeModelTimeline: false, includeLeaders: false, includeMessageStats: false,
            breakdowns: demand === 'insights' || demand === 'activity-insights' ? [] : demand === 'breakdowns' ? ['agent'] : ['project', 'machine'] });
        const richer = UsageAnalyticsQueryRequestSchema.parse({ ...base, ...(demand === 'insights' || demand === 'activity-insights'
            ? { includeInsights: true, activityResolution: 'both' } : { breakdowns: ['agent', 'machine', 'project', 'source'] }) });
        const snapshot: UsageAnalyticsSnapshot = { rows: [{ ...row('covered-demand', 0,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }), modelId: 'known-model',
            reportedCostUsd: 1 }],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: new Map([['session', 3]]) };
        const read = async (query: typeof base) => {
            const captured = { ...snapshot, messageCountsBySession: query.includeInsights || query.includeMessageStats
                ? snapshot.messageCountsBySession : undefined };
            const batch = await projectUsageAnalyticsBatch({ priceCatalog: snapshot.priceCatalog,
                snapshots: new Map([[getUsageAnalyticsQueryRequestKey(query), captured]]) }, [query], false, true);
            const result = batch.results[0]!;
            if (!('value' in result)) throw new Error('Expected an admitted accounting answer');
            return result.value;
        };
        const supplied = await read(richer);
        const expected = await read(base);
        let factReads = 0;
        const total = supplied.totals.tokens.total;
        Object.defineProperty(supplied.totals.tokens, 'total', { enumerable: true, get() { factReads++; return total; } });
        const projected = projectUsageAnalyticsResponseDemand(supplied, richer, base);
        expect(factReads, 'A narrower demand selects headers and references, without re-reading accounting facts').toBe(0);
        expect(projected).toBeDefined();
        expect(JSON.parse(JSON.stringify(projected))).toEqual(JSON.parse(JSON.stringify(expected)));
        expect(JSON.stringify(projected)).toBe(JSON.stringify(expected));
        expect(projected?.totals).toBe(supplied.totals);
        if (demand === 'breakdowns') {
            // Scalar and batch responses retain the canonical post-pricing status;
            // selected dimension evidence remains available independently.
            expect(supplied.coverage).toMatchObject({ status: 'complete', reasons: [], missingDimensions: ['project'] });
            expect(projected?.coverage).toMatchObject({ status: 'complete', reasons: [], missingDimensions: [] });
            expect(supplied.costFacts?.some(fact => fact.kind !== 'unpriced' && fact.complete)).toBe(true);
            expect(projected?.costFacts).toBe(supplied.costFacts);
            expect(projected?.breakdowns?.agent).toBe(supplied.breakdowns?.agent);
            expect(projected?.summary?.rankedPricing?.['breakdowns:agent']).toBe(supplied.summary?.rankedPricing?.['breakdowns:agent']);
            expect(projected?.summary?.rankedPricing?.['breakdowns:project']).toBeUndefined();
        }
    });

    it('declines subset borrowing when a removed truncated ranking cannot reveal the original coverage reason', async () => {
        const richer = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 }, includeSeries: false,
            breakdowns: ['agent', 'machine'], topLimit: 1 });
        const snapshot: UsageAnalyticsSnapshot = { rows: [row('one', 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }), { ...row('two', 5,
                { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }), machineId: 'second-machine' }],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const supplied = projectUsageAnalytics(snapshot, richer);
        expect(supplied.coverage?.ranked).toContainEqual(expect.objectContaining({ dimension: 'machine', complete: false }));
        expect(projectUsageAnalyticsResponseDemand(supplied, richer, { ...richer, breakdowns: ['agent'] })).toBeUndefined();
    });

    it('services native I/O during lazy Summary selection', async () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 },
            includeSeries: true, includeActivity: true, includeLeaders: true, includeModelTimeline: true, breakdowns: ['agent', 'machine'] });
        const snapshot: UsageAnalyticsSnapshot = { rows: [row('summary-fairness', 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } })],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const catalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
        const population = projectUsageAnalyticsPopulation(snapshot, query);
        const select = await projectUsageAnalyticsDemands(snapshot, [query], catalog, population, true);
        let ioSettled = false;
        let pendingIo: Promise<void> | undefined;
        const observedTurns: boolean[] = [];
        for (const contribution of population.totalContributions) {
            const tokens = contribution.tokens;
            const total = tokens.total;
            Object.defineProperty(tokens, 'total', { enumerable: true, get: () => {
                observedTurns.push(ioSettled);
                pendingIo ??= new Promise<void>(resolve => setImmediate(() => { ioSettled = true; resolve(); }));
                return total;
            } });
        }
        try {
            const selected = await select(query, snapshot);
            expect(observedTurns, 'I/O scheduled inside Summary must settle before later Summary populations are projected').toContain(true);
            expect(observedTurns).toContain(false);
            expect(selected).toMatchObject({ totals: { tokens: { total: 10 } }, summary: { v: 1,
                pricing: { totals: { groups: [{ tokens: { total: 10 } }] } } } });
            expect(selected.summary?.accountingCalendar).toBeDefined();
        } finally { await pendingIo; }
    });

    it('services native I/O during one admitted output preparation', async () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true, breakdowns: ['agent', 'machine'] });
        const snapshot: UsageAnalyticsSnapshot = { rows: [row('preparation-fairness', 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } })],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const catalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
        const population = projectUsageAnalyticsPopulation(snapshot, query);
        let ioSettled = false;
        let pendingIo: Promise<void> | undefined;
        const observedTurns: boolean[] = [];
        for (const contribution of population.totalContributions) {
            const tokens = contribution.tokens;
            Object.defineProperty(contribution, 'tokens', { enumerable: true, get: () => {
                observedTurns.push(ioSettled);
                pendingIo ??= new Promise<void>(resolve => setImmediate(() => { ioSettled = true; resolve(); }));
                return tokens;
            } });
        }
        try {
            const select = await projectUsageAnalyticsDemands(snapshot, [query], catalog, population, false);
            expect(observedTurns, 'I/O scheduled by an early preparation unit must settle before later units read the same population').toContain(true);
            expect(observedTurns).toContain(false);
            expect(await select(query, snapshot)).toMatchObject({ totals: { tokens: { total: 10 } },
                breakdowns: { agent: [{ key: 'codex' }], machine: [{ key: 'machine' }] }, series: [{ tokens: { total: 10 } }] });
        } finally { await pendingIo; }
    });

    it('services native I/O when committed population folding exhausts its elapsed slice', async () => {
        let ioSettled = false;
        let folding = false;
        let elapsedMs = 0;
        let pendingIo: Promise<void> | undefined;
        const observedTurns: boolean[] = [];
        const observedSubjects = new Map<string, boolean[]>();
        class ObservedInstant extends Date {
            constructor(readonly subjectId: string) { super(100); }
            override getTime() {
                if (folding) {
                    elapsedMs += 21;
                    observedTurns.push(ioSettled);
                    const turns = observedSubjects.get(this.subjectId) ?? [];
                    turns.push(ioSettled);
                    observedSubjects.set(this.subjectId, turns);
                    pendingIo ??= new Promise<void>(resolve => setImmediate(() => { ioSettled = true; resolve(); }));
                }
                return super.getTime();
            }
        }
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 }, includeSeries: false });
        const snapshot: UsageAnalyticsSnapshot = { rows: ['first', 'second', 'third'].map(id => ({ ...row(id, 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }, { sessionId: id }),
            observedAt: new ObservedInstant(id) })), legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const expected = projectUsageAnalytics(snapshot, query);
        const timing = new UsageQueryTiming();
        const measure = timing.measure.bind(timing);
        timing.measure = (phase, run) => measure(phase, () => {
            folding = phase === 'fold';
            try { return run(); } finally { folding = false; }
        });
        // The monotonic host clock is a system boundary; internal folding stays real.
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
        try {
            const batch = await projectUsageAnalyticsBatch({ priceCatalog: snapshot.priceCatalog,
                snapshots: new Map([[getUsageAnalyticsQueryRequestKey(query), snapshot]]) }, [query], true, false, timing);
            expect(observedTurns, 'expired fold slices must service native callbacks before continuing committed projection').toContain(true);
            expect(observedTurns).toContain(false);
            expect(observedSubjects.get('second')).toContain(true);
            expect(observedSubjects.get('third')).toContain(true);
            const result = batch.results[0];
            if (!result || !('value' in result)) throw new Error('Expected an admitted accounting answer');
            expect(result.value).toEqual((({ priceCatalog: _catalog, ...value }) => value)(expected));
        } finally { clock.mockRestore(); await pendingIo; }
    });

    it('lets pending I/O settle between population admission and output projection', async () => {
        let ioSettled = false;
        const observedTurns: boolean[] = [];
        class ObservedInstant extends Date {
            override getTime() { observedTurns.push(ioSettled); return super.getTime(); }
        }
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 }, includeSeries: true });
        const snapshot: UsageAnalyticsSnapshot = { rows: [{ ...row('fairness', 10,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }), observedAt: new ObservedInstant(100) }],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const pendingIo = new Promise<void>(resolve => setImmediate(() => { ioSettled = true; resolve(); }));
        try {
            const batch = await projectUsageAnalyticsBatch({ priceCatalog: snapshot.priceCatalog,
                snapshots: new Map([[getUsageAnalyticsQueryRequestKey(query), snapshot]]) }, [query], true, true);
            expect(observedTurns, 'CPU phases must not starve pending transaction/socket callbacks until the whole batch finishes').toContain(true);
            expect(observedTurns).toContain(false);
            expect(batch.results[0]).toMatchObject({ value: { totals: { tokens: { total: 10 } }, summary: { v: 1 } } });
        } finally { await pendingIo; }
    });

    it('admits captured metadata once across eight output demands while keeping changed populations independent', async () => {
        let metadataReads = 0;
        const rows = Array.from({ length: 2733 }, (_, index) => {
            const captured = row(`batch-${index}`, 10,
                { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
                { sessionId: `session-${index}` });
            const metadata = captured.metadata;
            Object.defineProperty(captured, 'metadata', { enumerable: true, get: () => { metadataReads++; return metadata; } });
            return captured;
        });
        const snapshot: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: new Map([['session-0', 3]]) };
        const base = { dateRange: { startMs: 0, endMs: 1000 }, includeSeries: false };
        const queries = [{ ...base }, { ...base, includeSeries: true }, { ...base, includeInsights: true },
            { ...base, includeActivity: true }, { ...base, includeLeaders: true }, { ...base, includeModelTimeline: true },
            { ...base, breakdowns: ['agent'] }, { ...base, breakdowns: ['machine'] }].map(query => UsageAnalyticsQueryRequestSchema.parse(query));
        const capture = (selected: typeof queries) => ({ priceCatalog: snapshot.priceCatalog,
            snapshots: new Map(selected.map(query => [getUsageAnalyticsQueryRequestKey(query), snapshot])) });
        await projectUsageAnalyticsBatch(capture([queries[0]!]), [queries[0]!], true);
        const single = metadataReads;
        metadataReads = 0;
        const sharedCapture = capture(queries);
        const batch = await projectUsageAnalyticsBatch(sharedCapture, queries, true);
        expect(metadataReads, 'output flags must not normalize/reconcile the same captured rows again').toBe(single);
        for (let index = 0; index < queries.length; index++) {
            const result = batch.results[index]!;
            expect('value' in result).toBe(true);
            if ('value' in result) {
                const { priceCatalog: _catalog, ...expected } = projectUsageAnalytics(snapshot, queries[index]!);
                expect(JSON.parse(JSON.stringify(result.value))).toEqual(JSON.parse(JSON.stringify(expected)));
            }
        }
        const changed = UsageAnalyticsQueryRequestSchema.parse({ ...base, filters: { agentIds: ['absent-agent'] } });
        const selected = [queries[0]!, changed, queries[1]!];
        const capturedControl = capture(selected);
        const timing = new UsageQueryTiming();
        const measure = timing.measure.bind(timing);
        const retainedSnapshotsAtPrice: number[] = [];
        timing.measure = (phase, run) => {
            if (phase === 'price') retainedSnapshotsAtPrice.push(capturedControl.snapshots.size);
            return measure(phase, run);
        };
        metadataReads = 0;
        const control = await projectUsageAnalyticsBatch(capturedControl, selected, true, false, timing);
        expect(metadataReads, 'distinct population folds consume the same admitted metadata within this batch').toBe(single);
        expect(control.results.map(result => 'value' in result ? result.value.totals.tokens.total : null)).toEqual([27330, 0, 27330]);
        // A pricing phase can resume more than once when its elapsed slice expires.
        const retainedTransitions = retainedSnapshotsAtPrice.filter((count, index, counts) => index === 0 || count !== counts[index - 1]);
        expect(retainedTransitions, 'pricing retains raw capture only for populations that have not folded yet').toEqual([1, 0]);
        expect(sharedCapture.snapshots.size, 'completed batch demands release their raw captured inputs').toBe(0);
        expect(capturedControl.snapshots.size).toBe(0);
    });

    it('projects admitted rows once for the union of eight output demands before selecting each result', async () => {
        let observedReads = 0;
        class CapturedInstant extends Date {
            override getTime() { observedReads++; return super.getTime(); }
        }
        const rows = Array.from({ length: 128 }, (_, index) => ({ ...row(`demand-${index}`, index % 4 + 1,
            { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
            { sessionId: `session-${index}` }), modelId: `model-${index % 8}`,
            observedAt: new CapturedInstant(100 + index % 2 * 86_400_000) }));
        const snapshot: UsageAnalyticsSnapshot = { rows, legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: new Map([['session-0', 3]]) };
        const base = { dateRange: { startMs: 0, endMs: 172_800_000 }, includeSeries: false, topLimit: 2 };
        const queries = [{ ...base }, { ...base, includeSeries: true }, { ...base, includeInsights: true },
            { ...base, includeActivity: true }, { ...base, includeLeaders: true, topLimit: 1 }, { ...base, includeModelTimeline: true, topLimit: 3 },
            { ...base, breakdowns: ['session'], topLimit: 40 }, { ...base, breakdowns: ['machine'] }].map(query => UsageAnalyticsQueryRequestSchema.parse(query));
        const union = UsageAnalyticsQueryRequestSchema.parse({ ...base, includeSeries: true, includeInsights: true,
            includeActivity: true, includeLeaders: true, includeModelTimeline: true, topLimit: 40, breakdowns: ['session', 'machine'] });
        const capture = (selected: typeof queries) => ({ priceCatalog: snapshot.priceCatalog,
            snapshots: new Map(selected.map(query => [getUsageAnalyticsQueryRequestKey(query), snapshot])) });
        await projectUsageAnalyticsBatch(capture([union]), [union], true, true);
        const unionReads = observedReads;
        observedReads = 0;
        const batch = await projectUsageAnalyticsBatch(capture(queries), queries, true, true);
        expect(observedReads, 'rows belong to one demand union, not each output slice').toBeLessThanOrEqual(unionReads);
        let compactRowReads = 0;
        const observedTokens = new Set<object>();
        for (const result of batch.results) if ('value' in result) for (const contribution of result.value.contributions ?? []) {
            const tokens = contribution.tokens;
            if (observedTokens.has(tokens)) continue;
            observedTokens.add(tokens);
            const total = tokens.total;
            Object.defineProperty(tokens, 'total', { enumerable: true, get: () => { compactRowReads++; return total; } });
        }
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries, contributionQueries: [] });
        const compact = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery(batch, input, false));
        expect(compactRowReads, 'delivery must select prepared grouped facts without rebuilding row populations').toBe(0);
        for (let index = 0; index < queries.length; index++) {
            const result = batch.results[index]!;
            if (!('value' in result)) throw new Error('Expected admitted accounting');
            const { priceCatalog: _catalog, ...expected } = projectUsageAnalytics(snapshot, queries[index]!);
            const { summary: _prepared, ...rich } = result.value;
            expect(JSON.parse(JSON.stringify(rich))).toEqual(JSON.parse(JSON.stringify(expected)));
            const scalar = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
                priceCatalog: batch.priceCatalog, results: [{ query: queries[index]!, value: expected }] }, input, false));
            expect(JSON.parse(JSON.stringify(compact.results[index]))).toEqual(JSON.parse(JSON.stringify(scalar.results[0])));
        }
    });

    it.each([false, true])('preserves readable totals and admitted detail across optional calendar failure (prepared Summary %s)', async prepareSummary => {
        // The ingest contract admits nonnegative integer timestamps without a
        // tighter cap. This valid Date overflows only after the calendar offset.
        const captured = { ...row('calendar-edge', 10, { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } }),
            observedAt: new Date(8_640_000_000_000_000) };
        const snapshot: UsageAnalyticsSnapshot = { rows: [captured], legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const queries = [false, true].map(includeActivity => UsageAnalyticsQueryRequestSchema.parse({
            includeSeries: false, includeActivity, timeZoneOffsetMinutes: 60 }));
        expect(projectUsageAnalytics(snapshot, queries[0]!).totals.tokens.total).toBe(10);
        expect(() => projectUsageAnalytics(snapshot, queries[1]!)).toThrow();
        const batch = await projectUsageAnalyticsBatch({ priceCatalog: snapshot.priceCatalog,
            snapshots: new Map(queries.map(query => [getUsageAnalyticsQueryRequestKey(query), snapshot])) }, queries, true, prepareSummary);
        expect(batch.results[0]).toMatchObject({ value: { totals: { tokens: { total: 10 } },
            contributions: [{ id: 'calendar-edge' }] } });
        expect(batch.results[1]).toMatchObject({ error: 'usage_query_failed' });
    });

    it('isolates an optional compact calendar failure after lazy Summary preparation', async () => {
        const snapshot: UsageAnalyticsSnapshot = { rows: [], legacyReports: [],
            priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined };
        const queries = [false, true].map(includeActivity => UsageAnalyticsQueryRequestSchema.parse({
            dateRange: { startMs: 2, endMs: 1 }, includeSeries: false, includeActivity }));
        const captured = { priceCatalog: snapshot.priceCatalog,
            snapshots: new Map(queries.map(query => [getUsageAnalyticsQueryRequestKey(query), snapshot])) };
        const batch = await projectUsageAnalyticsBatch(captured, queries, true, true);
        expect(batch.results[0]).toMatchObject({ value: { totals: { tokens: { total: 0 } }, summary: { v: 1 } } });
        expect(batch.results[1]).toMatchObject({ error: 'usage_query_failed' });
    });

    it('delivers private membership once per Session/turn, not once per accounting event', () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 }, includeSeries: false });
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query], contributionQueries: [], sessionQueries: [query] });
        const deliver = (events: number) => {
            const rows = Array.from({ length: events }, (_, index) => ({ ...row(`private-event-${index}`, 10,
                { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
                { sessionId: `session-${index % 2733}` }), turnId: `turn-${index % 2733}` }));
            const rich = projectUsageAnalytics({ rows, legacyReports: [],
                priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined }, query);
            const { priceCatalog, ...value } = rich;
            const response = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
                ...(priceCatalog ? { priceCatalog } : {}), results: [{ query, value }] }, input, false));
            const result = response.results[0]!;
            if (!('value' in result)) throw new Error('Expected admitted accounting');
            // Membership is a set. Captured event order may change which
            // Session/turn is witnessed first without changing its facts.
            result.value.sessionIds?.sort();
            result.value.sessionMembership?.turns.sort((left, right) =>
                left.sessionId.localeCompare(right.sessionId) || left.turnId.localeCompare(right.turnId));
            return { response, value: result.value };
        };
        const small = deliver(2733);
        const large = deliver(32_975);
        expect(large.value.sessionMembership?.turns).toHaveLength(2733);
        expect(large.value.sessionMembership).toEqual(small.value.sessionMembership);
        expect(large.value.sessionIds).toHaveLength(2733);
        expect(large.value.contributions).toBeUndefined();
        const serialized = JSON.stringify(large.response);
        expect(serialized).not.toContain('private-event-');
        expect(shape(large.response)).toEqual(shape(small.response));
        console.info('[usage-private-membership-bytes]', JSON.stringify({ events: 32975, sessions: 2733,
            turns: large.value.sessionMembership?.turns.length, bytes: Buffer.byteLength(serialized),
            smallBytes: Buffer.byteLength(JSON.stringify(small.response)) }));
    });

    it('delivers the same rendered slice shape for 32,975 events across 2,733 Sessions without serializing their identities', () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 },
            includeSeries: true, breakdowns: ['agent'], topLimit: 2 });
        const input = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [query], contributionQueries: [] });
        const deliver = (count: number) => {
            const rows = Array.from({ length: count }, (_, index) => row(`private-event-${index}`, 10,
                { usageAccounting: { path: 'runtime', status: 'available', historyComplete: true } },
                { sessionId: `private-session-${index % 2733}` }));
            const rich = projectUsageAnalytics({ rows, legacyReports: [],
                priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: undefined }, query);
            const { priceCatalog, ...value } = rich;
            const result = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
                ...(priceCatalog ? { priceCatalog } : {}), results: [{ query, value }] }, input, false));
            return { rich, result: UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(JSON.stringify(result))) };
        };
        const small = deliver(1);
        const large = deliver(32_975);
        expect(shape(large.result)).toEqual(shape(small.result));
        const serialized = JSON.stringify(large.result);
        expect(serialized).not.toContain('private-event-');
        expect(serialized).not.toContain('private-session-');
        const result = large.result.results[0]!;
        expect('value' in result).toBe(true);
        if ('value' in result) {
            expect(existingFacts(result.value.totals)).toEqual(existingFacts(large.rich.totals));
            expect(existingFacts(result.value.series)).toEqual(existingFacts(large.rich.series));
            expect(existingFacts(result.value.breakdowns)).toEqual(existingFacts(large.rich.breakdowns));
            // The compact-only basis must preserve availability, not merely hide a wire-shape difference.
            const compactPage = projectUsagePageCost(result.value, 'auto');
            const richPage = projectUsagePageCost(large.rich, 'auto');
            expect(compactPage.amountUsd).toBe(richPage.amountUsd);
            expect(compactPage.selection).toEqual(richPage.selection);
            const compactCosts = [result.value.totals.cost, ...result.value.series!.map(bucket => bucket.cost),
                ...result.value.breakdowns!.agent!.map(entry => entry.cost)];
            const richCosts = [large.rich.totals.cost, ...large.rich.series!.map(bucket => bucket.cost),
                ...large.rich.breakdowns!.agent!.map(entry => entry.cost)];
            expect(compactCosts.map(cost => resolveUsageCostBasis(cost, 'auto')))
                .toEqual(richCosts.map(cost => resolveUsageCostBasis(cost, 'auto')));
            expect(result.value.totals.tokens.total).toBe(329_750);
            expect(result.value.totals.eventCount).toBe(32_975);
        }
        console.info('[usage-server-delivery-bytes]', JSON.stringify({ events: 32_975, sessions: 2733,
            richBytes: Buffer.byteLength(JSON.stringify(large.rich)), summaryBytes: Buffer.byteLength(serialized),
            smallSummaryBytes: Buffer.byteLength(JSON.stringify(small.result)) }));
    });

    it('selects witnessed execution after native/runtime reconciliation and keeps mixed-Session message counts unqualified', () => {
        const snapshot: UsageAnalyticsSnapshot = {
            rows: [
                row('runtime', 10, { accountingSubject: subject, usageAccounting: { path: 'runtime', inferenceId: 'same' } }),
                row('duplicate', 10, { accountingSubject: subject, usageAccounting: { path: 'native', inferenceId: 'same' } }, { source: 'native' }),
                row('linked', 20, { accountingSubject: subject, usageAccounting: { path: 'native', inferenceId: 'linked' } }, { source: 'native' }),
                row('outside', 30, { accountingSubject: { kind: 'native', machineId: 'machine', agent: subject.agent,
                    sourceRootKey: 'root', nativeSessionKey: 'outside' },
                    usageAccounting: { path: 'native', inferenceId: 'outside' } }, { source: 'native', sessionId: null }),
                // Source ids alone do not witness execution, even in a Happier Session.
                row('unknown', 40, {}),
            ],
            legacyReports: [], priceCatalog: { fetchEnabled: false, stored: null }, messageCountsBySession: new Map([['session', 99]]),
        };
        const query = { granularity: 'day', includeActivity: true, includeModelTimeline: true, includeInsights: true,
            includeMessageStats: true, breakdowns: ['source'] };
        const whole = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse(query));
        expect(whole.totals.tokens.total).toBe(100);
        expect(whole.messageStats?.messageCount).toBe(99);
        for (const [execution, total] of [['happier', 30], ['outside', 30], ['unknown', 40]] as const) {
            const result = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({ ...query, filters: { execution } }));
            expect(result.totals.tokens.total).toBe(total);
            expect(result.contributions?.every(row => row.sourceContext?.execution === execution)).toBe(true);
            expect(result.series?.reduce((sum, row) => sum + row.tokens.total, 0)).toBe(total);
            expect(result.engineTimeline?.[0]?.leaders[0]?.sources?.every(row => row.execution === execution)).toBe(true);
            expect(result.coverage?.sources.map(row => row.path).sort()).toEqual(
                execution === 'happier' ? ['native', 'runtime'] : [execution === 'outside' ? 'native' : 'unknown']);
            expect(result.messageStats).toBeUndefined();
            expect(result.insights).toBeUndefined();
        }
        const native = projectUsageAnalytics(snapshot, UsageAnalyticsQueryRequestSchema.parse({ ...query, filters: { sources: ['native'] } }));
        expect(native.totals.tokens.total).toBe(50);
        expect(native.contributions?.map(row => row.sourceContext?.execution).sort()).toEqual(['happier', 'outside']);
    });
});
