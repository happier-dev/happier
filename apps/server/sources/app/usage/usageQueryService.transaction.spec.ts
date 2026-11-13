import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryBatchResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { restoreEnv, snapshotEnv } from '@/testkit/env';
import type { ScopedUsageEventDbRow } from './query/scopedUsageEventRow';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';
import { request as requestHttp, type ClientRequest } from 'node:http';
import { readUnexpectedActionErrorDiagnosticV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { usagePageCostProjectionBasis, type UsagePageCostProjectionBasis } from '@happier-dev/protocol/usage/usageCostFacts';

// Observe the OS scheduler while preserving its actual event-loop yield.
const schedulerBoundary = vi.hoisted(() => ({ onYield: () => {} }));
vi.mock('node:timers/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:timers/promises')>();
    return { ...actual, setImmediate<T>(value?: T, options?: import('node:timers').TimerOptions) {
        schedulerBoundary.onYield();
        return actual.setImmediate(value, options);
    } };
});

// Observe only the log sink; real HTTP exception classification remains installed.
const logSink = vi.hoisted(() => vi.fn());
vi.mock('@/utils/logging/log', () => ({ log: logSink }));

// Only the persistent database boundary is substituted. Transactions, retries,
// accounting, route registration and HTTP serialization all execute real code.
const boundary = createDbMocks({ usageReport: ['findMany'],
    homeSettings: ['findUnique'], homeGovernancePolicy: ['findUnique'], simpleCache: ['findFirst'] });
const usageEventRawRead = vi.fn();
const usageEventReads: boolean[] = [];
let committed = false;
let readingInTransaction = false;
let accountingRead = 0;
function eventForAttempt(attempt: number): ScopedUsageEventDbRow {
    return {
        id: 'event', sessionId: null, observedAt: new Date(100), createdAt: new Date(100),
        agentId: 'codex', backendMode: null, modelId: null, projectKey: null, workspaceId: null,
        machineId: null, source: 'runtime', scope: 'turn_delta', isCumulative: false, turnId: 'turn',
        externalKey: null, requestCount: 1, teamCredentialResourceId: null, teamCredentialActorAccountId: null,
        teamCredentialExternalApiKeyId: null, teamCredentialSourceCredentialId: null, brokerMachineId: null,
        credentialDeliveryMode: null, inputTokens: attempt * 7, outputTokens: 0, reasoningTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: attempt * 7, reportedCostUsd: 0,
        estimatedCostUsd: 0, invoiceCostUsd: 0, billingContext: null, costSource: null, currency: 'USD',
        costBreakdown: null, contextUsedTokens: null, contextWindowTokens: null, metadata: null,
    };
}
function transactionReader() {
    return { ...boundary.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock,
        async $queryRaw(query: TemplateStringsArray | { strings: readonly string[]; values?: readonly unknown[] }, ...values: unknown[]) {
            const sql = 'strings' in query ? query.strings.join('?') : query.join('?');
            if (sql.includes('FROM "UsageEvent"')) {
                usageEventReads.push(readingInTransaction);
                const rows = await usageEventRawRead(query) as object[];
                if (!sql.includes('"captureKind"')) return rows;
                const captured = rows.map(row => ({ ...row, captureKind: 'body' }));
                const payload = /jsonb_build_array\((.*?)\)::text AS payload/s.exec(sql);
                if (!payload) return captured;
                // Mirror the actual SQL result columns; the production decoder stays real.
                const keys = [...payload[1]!.matchAll(/c\."([^"]+)"/g)].map(match => match[1]!);
                return captured.map(row => ({ payload: JSON.stringify(keys.map(key => Reflect.get(row, key) ?? null)),
                    observedAt: Reflect.get(row, 'observedAt'), createdAt: Reflect.get(row, 'createdAt'),
                    reportUpdatedAt: null }));
            }
            if (sql.includes('UsageAccountingProjection')) throw new Error('Live query read derived Usage projection');
            return await inTxPostgresControlStatementMock.$queryRaw(query as TemplateStringsArray, ...values);
        },
    };
}
const transactions = createDbTransactionMock(transactionReader);
installDbModuleMock({ db: { ...transactionReader(), $transaction: async (fn: (tx: object) => Promise<unknown>) => {
    return transactions.transaction(fn);
} } });
const { createAuthenticatedTestApp, withAuthenticatedTestApp } = await import('@/app/api/testkit/sqliteFastify');
const { queryUsageAnalytics } = await import('./usageQueryService');
const { captureUsageAnalyticsBatch, projectUsageAnalyticsBatch } = await import('./query/readUsageAnalyticsBatch');
const { registerAccountUsageRoutes } = await import('@/app/api/routes/account/registerAccountUsageRoutes');
const { queryUsageAnalyticsBatch } = await import('./query/queryUsageAnalyticsBatch');

describe('Usage snapshot transaction lifetime', () => {
    const env = snapshotEnv();

    beforeEach(() => {
        process.env.HAPPIER_DB_PROVIDER = 'postgres';
        process.env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS = '0';
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'false';
        committed = false;
        readingInTransaction = false;
        accountingRead = 0;
        usageEventReads.length = 0;
        logSink.mockClear();
        boundary.db.homeSettings.findUnique.mockResolvedValue(null);
        boundary.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        boundary.db.simpleCache.findFirst.mockResolvedValue(null);
        boundary.db.usageReport.findMany.mockResolvedValue([]);
        usageEventRawRead.mockImplementation(async () => {
            committed = true;
            return [eventForAttempt(++accountingRead)];
        });
        transactions.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
            readingInTransaction = true;
            let result: unknown;
            try { result = await fn(transactionReader()); }
            finally { readingInTransaction = false; }
            return result;
        });
    });
    afterEach(() => { restoreEnv(env); boundary.reset(); usageEventRawRead.mockReset(); });

    it('shares identical running batch accounting and projection across independent JSON and NDJSON deliveries', async () => {
        let releaseCapture = () => {};
        const captured = new Promise<void>(resolve => { releaseCapture = resolve; });
        let capturedStarted = () => {};
        const started = new Promise<void>(resolve => { capturedStarted = resolve; });
        let held = true;
        usageEventRawRead.mockImplementation(async () => {
            const event = eventForAttempt(++accountingRead);
            capturedStarted();
            if (held) await captured;
            return [event];
        });
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const payload = { queries: [{}], includeContributions: true };
            const json = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload }).then(response => response);
            await started;
            const lines = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account', accept: 'application/x-ndjson' },
                payload: { includeContributions: true, queries: [{ includeSeries: true }] } }).then(response => response);
            await new Promise<void>(resolve => setImmediate(resolve));
            held = false;
            releaseCapture();
            const [jsonResponse, linesResponse] = await Promise.all([json, lines]);
            expect(jsonResponse.statusCode, jsonResponse.body).toBe(200);
            expect(linesResponse.statusCode, linesResponse.body).toBe(200);
            const jsonBatch = UsageAnalyticsQueryBatchResponseSchema.parse(jsonResponse.json());
            const lineBatches = linesResponse.body.trim().split('\n').map(line =>
                UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(line)));
            expect(usageEventRawRead, 'overlapping readers must share the accounting acquisition').toHaveBeenCalledTimes(1);
            expect(lineBatches.flatMap(batch => batch.results)).toEqual(jsonBatch.results);
            expect(jsonBatch.results[0]).toHaveProperty('value.totals.tokens.total', 7);
            const fresh = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload });
            expect(fresh.statusCode, fresh.body).toBe(200);
            expect(fresh.json()).toHaveProperty('results.0.value.totals.tokens.total', 14);
            expect(usageEventRawRead, 'finished results must never be retained').toHaveBeenCalledTimes(2);
        });
    });

    it.each([
        { label: 'Account', account: 'other-account', baseline: { queries: [{}] }, body: { queries: [{}] } },
        { label: 'query demand', account: 'account', baseline: { queries: [{}] },
            body: { queries: [{ dateRange: { startMs: 0, endMs: 200 } }] } },
        { label: 'contribution flag', account: 'account', baseline: { queries: [{}] }, body: { queries: [{}], includeContributions: true } },
        { label: 'summary delivery', account: 'account', baseline: { queries: [{}] }, body: { queries: [{}], contributionQueries: [] } },
        { label: 'detail selectors', account: 'account', baseline: { queries: [{}], contributionQueries: [] },
            body: { queries: [{}], contributionQueries: [{}] } },
        { label: 'Session selectors', account: 'account', baseline: { queries: [{}], contributionQueries: [] },
            body: { queries: [{}], contributionQueries: [], sessionQueries: [{}] } },
        { label: 'detail continuation', account: 'account', baseline: { queries: [{}], contributionQueries: [{}] },
            body: { queries: [{}], contributionQueries: [{}], contributionOffset: 1 } },
    ])('separates overlapping batch work by $label', async ({ account, baseline, body }) => {
        let releaseCapture = () => {};
        const held = new Promise<void>(resolve => { releaseCapture = resolve; });
        let captureStarted = () => {};
        const started = new Promise<void>(resolve => { captureStarted = resolve; });
        usageEventRawRead.mockImplementation(async () => {
            const event = eventForAttempt(++accountingRead);
            captureStarted();
            await held;
            return [event];
        });
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const original = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: baseline }).then(response => response);
            await started;
            const distinct = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': account }, payload: body }).then(response => response);
            await new Promise<void>(resolve => setImmediate(resolve));
            releaseCapture();
            const responses = await Promise.all([original, distinct]);
            expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
            expect(usageEventRawRead).toHaveBeenCalledTimes(2);
            expect(responses[0]!.json()).toHaveProperty('results.0.value.totals.tokens.total', 7);
            expect(responses[1]!.json()).toHaveProperty('results.0.value.totals.tokens.total', 14);
        });
    });

    it('keeps feature admission specific to each reader before joining batch work', async () => {
        let releaseCapture = () => {};
        const held = new Promise<void>(resolve => { releaseCapture = resolve; });
        let captureStarted = () => {};
        const started = new Promise<void>(resolve => { captureStarted = resolve; });
        usageEventRawRead.mockImplementation(async () => {
            const event = eventForAttempt(++accountingRead);
            captureStarted();
            await held;
            return [event];
        });
        process.env.HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED = '1';
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const payload = { queries: [{ population: 'public_eligible_personal' }, {}] };
            const admitted = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload }).then(response => response);
            await started;
            process.env.HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED = '0';
            const denied = app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload }).then(response => response);
            await new Promise<void>(resolve => setImmediate(resolve));
            releaseCapture();
            const [allowed, refused] = await Promise.all([admitted, denied]);
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(refused.statusCode, refused.body).toBe(200);
            expect(allowed.json().results[0]).toHaveProperty('value');
            expect(refused.json().results[0]).toMatchObject({ error: 'not_found' });
            expect(refused.json().results[1]).toHaveProperty('value.totals.tokens.total', 14);
            expect(usageEventRawRead).toHaveBeenCalledTimes(2);
        });
    });

    it('retires failed shared batch work so a new reader can acquire fresh facts', async () => {
        const body = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{}] });
        let releaseCapture = () => {};
        const held = new Promise<void>(resolve => { releaseCapture = resolve; });
        let captureStarted = () => {};
        const started = new Promise<void>(resolve => { captureStarted = resolve; });
        usageEventRawRead.mockImplementationOnce(async () => {
            captureStarted();
            await held;
            throw new Error('database read failed');
        });
        const first = queryUsageAnalyticsBatch('account', body, body.queries, () => false);
        await started;
        const second = queryUsageAnalyticsBatch('account', body, body.queries, () => false);
        releaseCapture();
        const settled = await Promise.allSettled([first, second]);
        expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected']);
        for (const result of settled) if (result.status === 'rejected') {
            expect(result.reason).toBeInstanceOf(Error);
            expect(result.reason.message).toBe('database read failed');
        }
        expect(usageEventRawRead).toHaveBeenCalledTimes(1);
        const recovered = await queryUsageAnalyticsBatch('account', body, body.queries, () => false);
        expect(recovered).toHaveProperty('results.0.value.totals.tokens.total', 7);
        expect(usageEventRawRead).toHaveBeenCalledTimes(2);
    });

    it('projects one captured population for four simultaneous readers', async () => {
        const body = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{ includeSeries: true }] });
        usageEventRawRead.mockImplementation(async () => Array.from({ length: 64 }, (_, index) => ({
            ...eventForAttempt(1), id: `event-${index}`, turnId: `turn-${index}`,
        })));
        let clockMs = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockMs += 25);
        let yields = 0;
        schedulerBoundary.onYield = () => { yields++; };
        try {
            const baseline = await queryUsageAnalyticsBatch('account', body, body.queries, () => false);
            const oneProjectionYields = yields;
            yields = 0;
            const joined = await Promise.all(Array.from({ length: 4 }, () =>
                queryUsageAnalyticsBatch('account', body, body.queries, () => false)));
            expect(joined).toEqual([baseline, baseline, baseline, baseline]);
            expect(oneProjectionYields).toBeGreaterThan(0);
            expect(yields, 'four readers must advance only one projection workload').toBe(oneProjectionYields);
            expect(usageEventRawRead, 'baseline plus one shared four-reader capture').toHaveBeenCalledTimes(2);
        } finally {
            schedulerBoundary.onYield = () => {};
            clock.mockRestore();
        }
    });

    it('continues shared projection while one admitted reader remains open', async () => {
        const body = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{}] });
        let releaseCapture = () => {};
        const held = new Promise<void>(resolve => { releaseCapture = resolve; });
        let captureStarted = () => {};
        const started = new Promise<void>(resolve => { captureStarted = resolve; });
        usageEventRawRead.mockImplementation(async () => {
            captureStarted();
            await held;
            return [eventForAttempt(1)];
        });
        let closed = false;
        const first = queryUsageAnalyticsBatch('account', body, body.queries, () => closed);
        await started;
        const survivor = queryUsageAnalyticsBatch('account', body, body.queries, () => false);
        closed = true;
        releaseCapture();
        const [abandoned, visible] = await Promise.all([first, survivor]);
        expect(visible).toHaveProperty('results.0.value.totals.tokens.total', 7);
        expect(abandoned).toBe(visible);
        expect(usageEventRawRead).toHaveBeenCalledTimes(1);
    });

    it('stops shared projection after every reader closes and releases the running entry', async () => {
        const body = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{}] });
        let closed = false;
        let projectionYields = 0;
        schedulerBoundary.onYield = () => { projectionYields++; closed = true; };
        try {
            const readers = Array.from({ length: 2 }, () =>
                queryUsageAnalyticsBatch('account', body, body.queries, () => closed));
            const settled = await Promise.allSettled(readers);
            expect(settled.map(result => result.status)).toEqual(['rejected', 'rejected']);
            for (const result of settled) if (result.status === 'rejected') {
                expect(result.reason).toBeInstanceOf(Error);
                expect(result.reason.message).toBe('Usage reader closed');
            }
            expect(projectionYields).toBe(1);
            schedulerBoundary.onYield = () => {};
            const fresh = await queryUsageAnalyticsBatch('account', body, body.queries, () => false);
            expect(fresh).toHaveProperty('results.0.value.totals.tokens.total', 14);
            expect(usageEventRawRead).toHaveBeenCalledTimes(2);
        } finally { schedulerBoundary.onYield = () => {}; }
    });

    it('does not revive abandoned work or let its settlement evict a replacement', async () => {
        const body = UsageAnalyticsQueryBatchRequestSchema.parse({ queries: [{}] });
        let releaseOriginal = () => {};
        let releaseReplacement = () => {};
        const originalHeld = new Promise<void>(resolve => { releaseOriginal = resolve; });
        const replacementHeld = new Promise<void>(resolve => { releaseReplacement = resolve; });
        let originalStarted = () => {};
        let replacementStarted = () => {};
        const originalReady = new Promise<void>(resolve => { originalStarted = resolve; });
        const replacementReady = new Promise<void>(resolve => { replacementStarted = resolve; });
        usageEventRawRead.mockImplementation(async () => {
            const attempt = ++accountingRead;
            if (attempt === 1) { originalStarted(); await originalHeld; }
            else { replacementStarted(); await replacementHeld; }
            return [eventForAttempt(attempt)];
        });
        let closed = false;
        const original = queryUsageAnalyticsBatch('account', body, body.queries, () => closed);
        const originalFailure = expect(original).rejects.toThrow('Usage reader closed');
        try {
            await originalReady;
            closed = true;
            const replacement = queryUsageAnalyticsBatch('account', body, body.queries, () => false);
            await replacementReady;
            releaseOriginal();
            await originalFailure;
            const joining = queryUsageAnalyticsBatch('account', body, body.queries, () => false);
            releaseReplacement();
            const [first, second] = await Promise.all([replacement, joining]);
            expect(first).toBe(second);
            expect(first).toHaveProperty('results.0.value.totals.tokens.total', 14);
            expect(usageEventRawRead).toHaveBeenCalledTimes(2);
        } finally {
            releaseOriginal();
            releaseReplacement();
        }
    });

    it('yields for slow batch projection only after releasing the snapshot transaction', async () => {
        let clockMs = 0;
        let yieldsInTransaction = 0;
        let yieldsAfterCommit = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockMs += 25);
        schedulerBoundary.onYield = () => {
            if (committed) yieldsAfterCommit++;
            else yieldsInTransaction++;
        };
        try {
            await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                    headers: { 'x-test-user-id': 'account' }, payload: {
                        queries: [{ dateRange: { startMs: 0, endMs: 200 }, includeSeries: true }],
                        includeContributions: true,
                    } });
                expect(response.statusCode, response.body).toBe(200);
                const batch = UsageAnalyticsQueryBatchResponseSchema.parse(response.json());
                expect(batch.results[0]).toHaveProperty('value.totals.tokens.total', 7);
                expect(usageEventReads).toEqual([false]);
                expect(yieldsInTransaction).toBe(0);
                expect(yieldsAfterCommit).toBeGreaterThan(0);
            });
        } finally {
            schedulerBoundary.onYield = () => {};
            clock.mockRestore();
        }
    });

    it('reads coherent raw Usage facts without an interactive transaction', async () => {
        const response = await queryUsageAnalytics('account', UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true }));
        expect(response.totals.tokens.total).toBe(7);
        expect(response.series?.[0]?.tokens.total).toBe(7);
        expect(committed).toBe(true);
        expect(usageEventReads).toEqual([false]);
        expect(transactions.transaction).not.toHaveBeenCalled();
    });

    it('retains one normalized accounting body per captured event across output demands', async () => {
        const query = UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true });
        const captured = await captureUsageAnalyticsBatch('account', [query]);
        let normalizedBodies: object[] = [];
        let normalizedEvidence: object[] = [];
        await expect(projectUsageAnalyticsBatch(captured, [query], false, false, undefined, undefined, () => {
            const snapshot = [...captured.snapshots.values()][0];
            if (!snapshot?.rows[0]?.accountingEvidence || snapshot.rawEvidenceRows !== undefined) return false;
            normalizedBodies = snapshot.rows;
            normalizedEvidence = [...snapshot.normalizedEvidenceById!.values()];
            return true;
        })).rejects.toThrow('Usage reader closed');
        expect(normalizedBodies).toHaveLength(1);
        expect(new Set([...normalizedBodies, ...normalizedEvidence]).size,
            'evidence and body readers must borrow the same admitted event, without retaining a second full-row copy').toBe(1);
    });

    it.each([false, true])('retains priced event detail only when the batch requests it (%s)', async detail => {
        const count = 128;
        usageEventRawRead.mockImplementation(async () => Array.from({ length: count }, (_, index) => ({
            ...eventForAttempt(1), id: `event-${index}`, turnId: `turn-${index}`, modelId: 'gpt-4o',
        })));
        const queries = [{ includeActivity: true },
            { includeSeries: true, includeModelTimeline: true }].map(query => UsageAnalyticsQueryRequestSchema.parse(query));
        const captured = await captureUsageAnalyticsBatch('account', queries);
        const batch = await projectUsageAnalyticsBatch(captured, queries, detail);
        for (const result of batch.results) {
            if (!('value' in result)) throw new Error('Usage projection failed');
            expect(result.value.totals.tokens.total).toBe(count * 7);
            expect(result.value.contributions?.length).toBe(detail ? count : undefined);
            const priced = (result.value.totals.cost as typeof result.value.totals.cost & {
                [usagePageCostProjectionBasis]?: UsagePageCostProjectionBasis;
            })[usagePageCostProjectionBasis]?.response.contributions;
            expect(priced?.length ?? 0,
                'omitting contributions must also release their hidden pricing-basis reference').toBe(detail ? count : 0);
        }
    });

    it.each(['service', 'v1', 'v2'])('yields during slow %s projection after releasing its database reads', async surface => {
        let clockMs = 0;
        let yieldedWhileReading = false;
        let yieldCount = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockMs += 25);
        schedulerBoundary.onYield = () => {
            yieldedWhileReading ||= readingInTransaction;
            yieldCount++;
        };
        try {
            const query = UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true });
            if (surface === 'service') {
                const result = await queryUsageAnalytics('account', query);
                expect(result.totals.tokens.total).toBe(7);
                expect(result.contributions).toHaveLength(1);
                expect(result.priceCatalog).toBeDefined();
            } else await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
                const response = await app.inject({ method: 'POST', url: surface === 'v1' ? '/v1/usage/query' : '/v2/usage/query',
                    headers: { 'x-test-user-id': 'account' }, payload: surface === 'v1' ? {} : query });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toHaveProperty(surface === 'v1' ? 'usage.0.tokens.total' : 'totals.tokens.total', 7);
            });
            expect(yieldedWhileReading).toBe(false);
            expect(yieldCount).toBeGreaterThan(0);
        } finally {
            schedulerBoundary.onYield = () => {};
            clock.mockRestore();
        }
    });

    it.each([
        { url: '/v2/usage/query-batch', accept: 'application/json' },
        { url: '/v2/usage/query-batch', accept: 'application/x-ndjson' },
        { url: '/v1/usage/query', accept: 'application/json' },
        { url: '/v2/usage/query', accept: 'application/json' },
    ])('does not send $accept after a real client cancels during $url projection', async ({ url, accept }) => {
            const app: Parameters<typeof registerAccountUsageRoutes>[0] = createAuthenticatedTestApp();
            let clockMs = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => clockMs += 25);
            let client: ClientRequest | undefined;
            let closedAfterCommit = false;
            let projectionYieldsAfterClose = 0;
            schedulerBoundary.onYield = () => {
                if (closedAfterCommit) projectionYieldsAfterClose++;
            };
            const sendsAfterClose: number[] = [];
            const streamsSettled: Promise<void>[] = [];
            const transportErrors: Array<{ name: string; code: string | null; stackHeader: string | undefined;
                diagnostic: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1> }> = [];
            let finishHandler = () => {};
            const handlerFinished = new Promise<void>(resolve => { finishHandler = resolve; });
            // Observe the real transport handler without replacing its projection or stream.
            app.addHook('onRoute', route => {
                if (route.url !== url) return;
                const handler = route.handler;
                route.handler = async function (request, reply) {
                    try { return await handler.call(this, request, reply); }
                    finally { finishHandler(); }
                };
            });
            app.addHook('onRequest', async (_request, reply) => {
                reply.raw.on('close', () => { closedAfterCommit = committed; });
            });
            app.addHook('onSend', async (_request, reply, payload) => {
                if (reply.raw.destroyed) sendsAfterClose.push(reply.statusCode);
                if (payload instanceof Readable) streamsSettled.push(finished(payload, { cleanup: true }).catch(() => {}));
            });
            app.addHook('onError', async (_request, _reply, error) => {
                transportErrors.push({ name: error.name, code: typeof error.code === 'string' ? error.code : null,
                    stackHeader: error.stack?.split('\n')[0], diagnostic: readUnexpectedActionErrorDiagnosticV1(error) });
            });
            registerAccountUsageRoutes(app);
            usageEventRawRead.mockImplementation(async () => {
                const event = eventForAttempt(++accountingRead);
                const captured = Array.from({ length: 64 }, (_, index) => ({ ...event,
                    id: `event-${index}`, turnId: `turn-${index}` }));
                committed = true;
                // A real client closes after capture returns and before the
                // committed projector resumes from its normal I/O yields.
                setImmediate(() => client!.destroy());
                return captured;
            });
            try {
                const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
                client = requestHttp(`${baseUrl}${url}`, { method: 'POST', headers: {
                    'x-test-user-id': 'account', 'content-type': 'application/json', accept,
                } });
                client.on('error', () => {}); // ECONNRESET is the client's intentional cancellation.
                client.on('response', response => response.resume());
                client.end(JSON.stringify(url === '/v2/usage/query-batch'
                    ? { queries: [{}, { breakdowns: ['model'] }], includeContributions: true } : {}));
                await handlerFinished;
                await Promise.all(streamsSettled);
            } finally {
                schedulerBoundary.onYield = () => {};
                clock.mockRestore();
                client?.destroy();
                await app.close();
            }
            expect(closedAfterCommit).toBe(true);
            expect(projectionYieldsAfterClose).toBe(0);
            expect(transportErrors).toEqual([]);
            expect(sendsAfterClose).toEqual([]);
            expect(logSink.mock.calls.filter(([entry]) => entry?.module === 'fastify-error'
                && entry.statusCode >= 500)).toEqual([]);
        });

    it('keeps an attached client failure visible through the real batch error handler', async () => {
        usageEventRawRead.mockRejectedValue(new Error('database read failed'));
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: { queries: [{}] } });
            expect(response.statusCode).toBe(500);
            expect(logSink.mock.calls.some(([entry]) => entry?.module === 'fastify-error'
                && entry.statusCode === 500)).toBe(true);
        });
    });

    it.each(['service', '/v1/usage/query', '/v2/usage/query', '/v2/usage/query-batch'])(
        '%s captures coherent headers and bodies while a writer settles, then sees the settlement next request', async entry => {
            let settled = false;
            const original = { ...eventForAttempt(1), observedAt: new Date(1500), modelId: 'original-model',
                inputTokens: 10, totalTokens: 10 };
            const settlement = { ...original, modelId: 'settled-model', inputTokens: 20, totalTokens: 20 };
            let readsInCapture = 0;
            usageEventRawRead.mockImplementation(async (query: { strings: readonly string[] }) => {
                const sql = query.strings.join('?');
                const row = settled ? settlement : original;
                // A separate writer settles after the single accounting statement has read its facts.
                if (++readsInCapture === 1) settled = true;
                return [Object.fromEntries(Object.entries(row).filter(([key]) => sql.includes(`"${key}"`)))];
            });
            const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 1000, endMs: 2001 },
                breakdowns: ['model'] });
            const expectSnapshot = (result: ReturnType<typeof UsageAnalyticsQueryResponseSchema.parse>, tokens: number,
                modelId: string) => {
                expect(result.totals.tokens.total).toBe(tokens);
                expect(result.contributions?.[0]).toMatchObject({ modelId, tokens: { total: tokens } });
            };
            if (entry === 'service') {
                expectSnapshot(await queryUsageAnalytics('account', query), 10, 'original-model');
                expect(readsInCapture).toBe(1);
                expect(settled).toBe(true);
                expectSnapshot(await queryUsageAnalytics('account', query), 20, 'settled-model');
                return;
            }
            await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
                for (const [tokens, modelId] of [[10, 'original-model'], [20, 'settled-model']] as const) {
                    readsInCapture = 0;
                    const response = await app.inject({ method: 'POST', url: entry,
                        headers: { 'x-test-user-id': 'account' }, payload: entry.startsWith('/v1')
                            ? { startTime: 1, endTime: 2 } : entry.endsWith('query-batch')
                                ? { queries: [query], includeContributions: true } : query });
                    expect(response.statusCode, response.body).toBe(200);
                    expect(settled).toBe(true);
                    expect(readsInCapture).toBe(1);
                    const body = response.json();
                    if (entry.startsWith('/v1')) expect(body.usage[0].tokens.total).toBe(tokens);
                    else expectSnapshot(UsageAnalyticsQueryResponseSchema.parse(entry.endsWith('query-batch')
                        ? body.results[0].value : body), tokens, modelId);
                }
            });
        });

    it('shares one coherent accounting statement per bounded page batch, deduplicates slices and delivers raw accounting on request', async () => {
        const current = { dateRange: { startMs: 0, endMs: 200 }, breakdowns: ['agent'], costMode: 'auto' };
        const other = { ...current, breakdowns: ['model'], costMode: 'api_equivalent' };
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: { queries: [current, other, current] } });
            expect(response.statusCode, response.body).toBe(200);
            const batch = response.json();
            expect(batch.results).toHaveLength(2);
            expect(usageEventReads).toEqual([false]);
            const [accountingQuery] = usageEventRawRead.mock.calls.map(([query]) => query.strings.join('?'));
            expect(accountingQuery).toContain('"metadata"');
            expect(accountingQuery).toContain('"totalTokens"');
            expect(accountingQuery).toContain('"UsageReport"');
            for (const result of batch.results) {
                expect(result.value.totals.tokens.total).toBe(7);
                expect(result.value).not.toHaveProperty('contributions');
                expect(result.value).not.toHaveProperty('priceCatalog');
            }
            expect(batch).not.toHaveProperty('priceCatalog');
            const raw = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: { queries: [current, other], includeContributions: true } });
            expect(raw.statusCode, raw.body).toBe(200);
            expect(raw.json().priceCatalog).toBeDefined();
            for (const result of raw.json().results) {
                expect(result.value.contributions).toHaveLength(1);
                expect(result.value.totals.tokens.total).toBe(14);
                expect(result.value).not.toHaveProperty('priceCatalog');
            }
            const streamed = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account', accept: 'application/x-ndjson' },
                payload: { queries: [current, other, current], includeContributions: true } });
            expect(streamed.statusCode, streamed.body).toBe(200);
            expect(streamed.headers['content-type']).toContain('application/x-ndjson');
            const streamedBody: string = streamed.body;
            const chunks = streamedBody.trim().split('\n').map(line => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(line)));
            expect(chunks.filter(chunk => chunk.priceCatalog)).toHaveLength(1);
            expect(chunks.flatMap(chunk => chunk.results)).toHaveLength(2);
            expect(chunks.flatMap(chunk => chunk.results).every(row => 'value' in row && row.value.totals.tokens.total === 21)).toBe(true);
        });
    });

    it.each([true, false])('admits the public population only when its real capability is enabled (%s)', async enabled => {
        process.env.HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED = enabled ? '1' : '0';
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query',
                headers: { 'x-test-user-id': 'account' }, payload: { population: 'public_eligible_personal' } });
            expect(response.statusCode, response.body).toBe(enabled ? 200 : 404);
            if (enabled) {
                expect(UsageAnalyticsQueryResponseSchema.safeParse(response.json()).success).toBe(true);
                expect(committed).toBe(true);
            } else {
                expect(response.json()).toEqual({ error: 'not_found' });
            }
            const batchResponse = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: { queries: [{ population: 'public_eligible_personal' }, {}] } });
            expect(batchResponse.statusCode, batchResponse.body).toBe(200);
            const batch = UsageAnalyticsQueryBatchResponseSchema.parse(batchResponse.json());
            expect(batch.results).toHaveLength(2);
            const personal = batch.results.find(row => row.query.population === undefined)!;
            expect(personal).toHaveProperty('value');
            const published = batch.results.find(row => row.query.population === 'public_eligible_personal')!;
            if (enabled) expect(published).toHaveProperty('value');
            else expect(published).toMatchObject({ error: 'not_found' });
        });
    });

});
