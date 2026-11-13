import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, UsageAnalyticsQueryBatchResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
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
