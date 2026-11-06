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
let attempt = 0;
let retry = false;
let isolationLevel: string | undefined;
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
                usageEventReads.push(!committed);
                return await usageEventRawRead(query);
            }
            if (sql.includes('UsageAccountingProjection')) throw new Error('Live query read derived Usage projection');
            return await inTxPostgresControlStatementMock.$queryRaw(query as TemplateStringsArray, ...values);
        },
    };
}
const transactions = createDbTransactionMock(transactionReader);
// Preserve the real transaction options: the generic mock wrapper omits them.
installDbModuleMock({ db: { ...boundary.db, $transaction: async (fn: (tx: object) => Promise<unknown>,
    options?: { isolationLevel?: string }) => {
    isolationLevel = options?.isolationLevel;
    return transactions.transaction(fn);
} } });
const { createAuthenticatedTestApp, withAuthenticatedTestApp } = await import('@/app/api/testkit/sqliteFastify');
const { queryUsageAnalytics } = await import('./usageQueryService');
const { registerAccountUsageRoutes } = await import('@/app/api/routes/account/registerAccountUsageRoutes');

describe('Usage snapshot transaction lifetime', () => {
    const env = snapshotEnv();

    beforeEach(() => {
        process.env.HAPPIER_DB_PROVIDER = 'postgres';
        process.env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS = '0';
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'false';
        committed = false;
        attempt = 0;
        retry = false;
        isolationLevel = undefined;
        usageEventReads.length = 0;
        logSink.mockClear();
        boundary.db.homeSettings.findUnique.mockResolvedValue(null);
        boundary.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        boundary.db.simpleCache.findFirst.mockResolvedValue(null);
        boundary.db.usageReport.findMany.mockResolvedValue([]);
        usageEventRawRead.mockImplementation(async () => [eventForAttempt(attempt)]);
        transactions.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
            attempt++;
            const result = await fn(transactionReader());
            if (retry && attempt === 1) throw Object.assign(new Error('Commit rolled back'), { code: 'P2034' });
            committed = true;
            return result;
        });
    });
    afterEach(() => { restoreEnv(env); boundary.reset(); usageEventRawRead.mockReset(); });

    it('reads raw Usage facts inside the transaction and replies after it commits', async () => {
        const response = await queryUsageAnalytics('account', UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true }));
        expect(response.totals.tokens.total).toBe(7);
        expect(response.series?.[0]?.tokens.total).toBe(7);
        expect(committed).toBe(true);
        expect(usageEventReads).toEqual([true]);
    });

    it.each(['application/json', 'application/x-ndjson'])(
        'does not send %s after a real client cancels during committed batch projection', async accept => {
            const app: Parameters<typeof registerAccountUsageRoutes>[0] = createAuthenticatedTestApp();
            let client: ClientRequest | undefined;
            let closedAfterCommit = false;
            const sendsAfterClose: number[] = [];
            const streamsSettled: Promise<void>[] = [];
            const transportErrors: Array<{ name: string; code: string | null; stackHeader: string | undefined;
                diagnostic: ReturnType<typeof readUnexpectedActionErrorDiagnosticV1> }> = [];
            let finishHandler = () => {};
            const handlerFinished = new Promise<void>(resolve => { finishHandler = resolve; });
            // Observe the real transport handler without replacing its projection or stream.
            app.addHook('onRoute', route => {
                if (route.url !== '/v2/usage/query-batch') return;
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
            transactions.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
                attempt++;
                const captured = await fn(transactionReader());
                committed = true;
                // A real client closes after capture returns and before the
                // committed projector resumes from its normal I/O yields.
                setImmediate(() => client!.destroy());
                return captured;
            });
            try {
                const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
                client = requestHttp(`${baseUrl}/v2/usage/query-batch`, { method: 'POST', headers: {
                    'x-test-user-id': 'account', 'content-type': 'application/json', accept,
                } });
                client.on('error', () => {}); // ECONNRESET is the client's intentional cancellation.
                client.on('response', response => response.resume());
                client.end(JSON.stringify({ queries: [{}, { breakdowns: ['model'] }], includeContributions: true }));
                await handlerFinished;
                await Promise.all(streamsSettled);
            } finally {
                client?.destroy();
                await app.close();
            }
            expect(closedAfterCommit).toBe(true);
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
            let captured = original;
            let readsInCapture = 0;
            transactions.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
                captured = settled ? settlement : original;
                readsInCapture = 0;
                return fn(transactionReader());
            });
            usageEventRawRead.mockImplementation(async (query: { strings: readonly string[] }) => {
                const sql = query.strings.join('?');
                const row = isolationLevel === 'ReadCommitted' && settled ? settlement : captured;
                // A separate writer commits after evidence has been read, before body hydration.
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

    it('shares one raw snapshot read per page batch, deduplicates slices and delivers raw accounting on request', async () => {
        const current = { dateRange: { startMs: 0, endMs: 200 }, breakdowns: ['agent'], costMode: 'auto' };
        const other = { ...current, breakdowns: ['model'], costMode: 'api_equivalent' };
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { 'x-test-user-id': 'account' }, payload: { queries: [current, other, current] } });
            expect(response.statusCode, response.body).toBe(200);
            const batch = response.json();
            expect(batch.results).toHaveLength(2);
            expect(usageEventReads).toEqual([true]);
            const [snapshotQuery] = usageEventRawRead.mock.calls.map(([query]) => query.strings.join('?'));
            expect(snapshotQuery).toContain('"totalTokens"');
            expect(snapshotQuery).toContain('"metadata"');
            expect(boundary.db.usageReport.findMany).toHaveBeenCalledTimes(1);
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
            expect(response.statusCode).toBe(enabled ? 200 : 404);
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

    it.each(['/v1/usage/query', '/v2/usage/query'])('replies from %s only after a successful retry commits', async url => {
        retry = true;
        const repliesBeforeCommit: boolean[] = [];
        await withAuthenticatedTestApp(app => {
            registerAccountUsageRoutes(app);
            app.addHook('onSend', async () => { repliesBeforeCommit.push(!committed); });
        }, async app => {
            const response = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': 'account' }, payload: {} });
            // An early HTTP response must not let teardown race a still-running retry.
            await vi.waitFor(() => expect(committed).toBe(true));
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(url.startsWith('/v1') ? body.usage[0].tokens.total : body.totals.tokens.total).toBe(14);
            expect(repliesBeforeCommit).toEqual([false]);
            expect(attempt).toBe(2);
        });
    });
});
