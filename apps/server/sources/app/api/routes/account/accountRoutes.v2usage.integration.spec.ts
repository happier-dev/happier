import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EphemeralUpdateSchema } from "@happier-dev/protocol/updates";
import { eventRouter } from "@/app/events/eventRouter";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { accountRoutes } from "./accountRoutes";
import { TransactionConflictExhaustedError, TransactionDeadlineExceededError } from "@/storage/transactionErrors";
import { normalizeUsageQuery, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryBatchResponseSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { request as requestHttp } from 'node:http';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction, RouteOptions } from 'fastify';
import type { TransactionClient } from '@/storage/prisma';

const databaseFault = vi.hoisted(() => ({ error: null as unknown,
    onSnapshot: null as ((reader: TransactionClient) => TransactionClient) | null }));
// Substitute only database adapters; transaction classification, routes and HTTP serialization stay real.
vi.mock("@/storage/db", async importOriginal => {
    const actual = await importOriginal<typeof import("@/storage/db")>();
    return { ...actual, db: new Proxy(actual.db, {
        get(target, key) {
            const value: unknown = Reflect.get(target, key);
            if (key !== "$transaction" || typeof value !== "function") return value;
            return (...args: unknown[]) => databaseFault.error ? Promise.reject(databaseFault.error) : Reflect.apply(value, target, args);
        },
    }) };
});
vi.mock("@/storage/prisma", async importOriginal => {
    const actual = await importOriginal<typeof import("@/storage/prisma")>();
    return { ...actual, withSqliteReadSnapshot: (...args: Parameters<typeof actual.withSqliteReadSnapshot>) => {
        if (databaseFault.error) throw databaseFault.error;
        return actual.withSqliteReadSnapshot(reader => {
            return args[0](databaseFault.onSnapshot?.(reader) ?? reader);
        }, args[1]);
    } };
});

const { emitEphemeral } = vi.hoisted(() => ({
    emitEphemeral: vi.fn(),
}));

vi.mock("@/utils/logging/log", () => ({ log: vi.fn() }));

describe("accountRoutes v2 usage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-account-usage-", initAuth: false });
        // Spy after the real route graph initializes, preserving its payload builders.
        vi.spyOn(eventRouter, "emitEphemeral").mockImplementation(emitEphemeral);
    }, 120_000);

    afterAll(async () => {
        vi.restoreAllMocks();
        await harness.close();
    });

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        harness.resetEnv();
    });

    afterEach(async () => {
        databaseFault.error = null;
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.repeatKey.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it.each(['/v1/usage/query', '/v2/usage/query', '/v2/usage/query-batch'])(
        'reads raw Usage without building a projection through %s', async url => {
        const account = await db.account.create({ data: { publicKey: `pk-usage-lazy-${url}` } });
        const unrelated = await db.account.create({ data: { publicKey: `pk-usage-unvisited-${url}` } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(100),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', inputTokens: 7, totalTokens: 7 } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const response = await app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': account.id },
                payload: url.endsWith('query-batch') ? { queries: [{}], contributionQueries: [] } : {} });
            expect(response.statusCode, response.body).toBe(200);
            const body = response.json();
            expect(url.endsWith('query-batch') ? body.results[0].value.totals.tokens.total
                : url.startsWith('/v1/') ? body.usage[0]?.tokens.total : body.totals.tokens.total).toBe(7);
            expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
            expect(await db.usageAccountingProjection.count({ where: { accountId: unrelated.id } })).toBe(0);
        });
    });

    it.each(['/v1/usage/query', '/v2/usage/query', '/v2/usage/query-batch'])(
        'does no row projection after the HTTP reader closes during capture through %s, and serves the next reader', async url => {
        const account = await db.account.create({ data: { publicKey: `pk-usage-aborted-${url}` }, select: { id: true } });
        await db.usageEvent.createMany({ data: [1, 2, 3].map(index => ({ accountId: account.id,
            observedAt: new Date(index), agentId: 'codex', source: 'runtime', scope: 'turn_delta', inputTokens: index, totalTokens: index })) });
        let readStarted!: () => void;
        let readFailed!: (error: Error) => void;
        let releaseRead!: () => void;
        let readerClosed!: () => void;
        let handlerFinished!: () => void;
        const started = new Promise<void>((resolve, reject) => { readStarted = resolve; readFailed = reject; });
        const released = new Promise<void>(resolve => { releaseRead = resolve; });
        const closed = new Promise<void>(resolve => { readerClosed = resolve; });
        const finished = new Promise<void>(resolve => { handlerFinished = resolve; });
        let pause = true;
        let projectedRows = 0;
        let repliesAfterClose = 0;
        // Pause only the genuine persistence boundary. Real admission, accounting,
        // projection and HTTP lifecycle remain exercised beneath the route.
        databaseFault.onSnapshot = reader => new Proxy(reader, { get(target, key, receiver) {
            if (key !== 'usageEvent') return Reflect.get(target, key, receiver);
            return new Proxy(target.usageEvent, { get(eventReader, method, eventReceiver) {
                if (method !== 'findMany') return Reflect.get(eventReader, method, eventReceiver);
                return async (...args: Parameters<typeof eventReader.findMany>) => {
                    const rows = await eventReader.findMany(...args);
                    if (pause) { pause = false; readStarted(); await released; }
                    return rows.map(row => new Proxy(row, { get(value, property, valueReceiver) {
                        projectedRows++;
                        return Reflect.get(value, property, valueReceiver);
                    } }));
                };
            } });
        } });
        try {
            await withAuthenticatedTestApp(app => {
                app.addHook('onRoute', (options: RouteOptions) => {
                    if (options.url !== url) return;
                    const handler = options.handler;
                    options.handler = async function (request, reply) {
                        try { return await handler.call(this, request, reply); }
                        finally { handlerFinished(); }
                    };
                });
                app.addHook('onRequest', (_request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
                    reply.raw.once('close', readerClosed);
                    done();
                });
                app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
                    if (reply.raw.destroyed) repliesAfterClose++;
                    handlerFinished();
                    return payload;
                });
                accountRoutes(app);
            }, async app => {
                const address: string = await app.listen({ host: '127.0.0.1', port: 0 });
                const payload = url.endsWith('query-batch') ? { queries: [{}], contributionQueries: [] } : {};
                const client = requestHttp(address + url, { method: 'POST', headers: {
                    'content-type': 'application/json', 'x-test-user-id': account.id,
                } }, response => {
                    response.resume();
                    readFailed(new Error(`HTTP ${response.statusCode} completed before the paused database read`));
                });
                client.on('error', () => {});
                client.end(JSON.stringify(payload));
                try {
                    await started;
                    client.destroy();
                    await closed;
                } finally { client.destroy(); releaseRead(); }
                await finished;
                expect(projectedRows).toBe(0);
                expect(repliesAfterClose).toBe(0);
                const next = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': account.id }, payload });
                expect(next.statusCode, next.body).toBe(200);
                expect(projectedRows).toBeGreaterThan(0);
                expect(url.endsWith('query-batch') ? next.json().results[0].value.totals.tokens.total
                    : url.startsWith('/v1/') ? next.json().usage[0].tokens.total : next.json().totals.tokens.total).toBe(6);
            });
        } finally { releaseRead(); databaseFault.onSnapshot = null; }
    });

    it.each(["/v1/usage/query", "/v2/usage/query"].flatMap(url => [
        { url, code: "database_transaction_timeout", failure: () => new TransactionDeadlineExceededError(new Error("private database detail"), "usage-query") },
        { url, code: "database_transaction_conflict_exhausted", failure: () => new TransactionConflictExhaustedError(new Error("private database detail")) },
    ]))("preserves terminal storage $code and recovery through $url", async ({ url, code, failure }) => {
        const account = await db.account.create({ data: { publicKey: `pk-query-deadline-${url}` }, select: { id: true } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const query = () => app.inject({ method: "POST", url,
                headers: { "x-test-user-id": account.id }, payload: {} });
            databaseFault.error = failure();
            const unavailable = await query();
            expect(unavailable.statusCode, unavailable.body).toBe(503);
            expect(unavailable.json()).toEqual({ error: code, statusCode: 503 });
            expect(unavailable.body).not.toContain("private");
            databaseFault.error = new Error("private unrelated failure");
            const unexpected = await query();
            expect(unexpected.statusCode).toBe(500);
            expect(unexpected.body).not.toContain("private");
            databaseFault.error = null;
            expect((await query()).statusCode).toBe(200);
        });
    });

    it('preserves unmeasured totals for the QA-ACCT exact empty model/Machine clauses on scalar and batch routes', async () => {
        const account = await db.account.create({ data: { publicKey: 'qa-usage-acct-1030-empty', encryptionMode: 'plain' }, select: { id: true } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(), agentId: 'codex',
            modelId: 'a-different-model', source: 'runtime', scope: 'turn_delta', inputTokens: 7, totalTokens: 7 } });
        const common = { machines: ['ae694c29-6fe7-4324-b7d3-0bff5a8961e0'], breakdown: ['model'], includeQuotaHistory: false,
            includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false, timeZoneOffsetMinutes: 0 };
        const counters = ['qa-usage-acct-1030-counter-a', 'qa-usage-acct-1030-counter-b'];
        const input = [{ ...common, period: { relative: 'today' }, modelIds: counters }, { ...common, period: {}, modelIds: counters },
            { ...common, period: { relative: 'today' }, modelIds: ['qa-usage-acct-1030-model-a', 'qa-usage-acct-1030-model-b'] }];
        const queries = input.map(value => usageQueryToAnalyticsRequest(normalizeUsageQuery(value)));
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': account.id };
            const unfiltered = await app.inject({ method: 'POST', url: '/v2/usage/query', headers, payload: {} });
            expect(unfiltered.json().totals.tokens.total).toBe(7);
            for (const query of queries) {
                const response = await app.inject({ method: 'POST', url: '/v2/usage/query', headers, payload: query });
                expect(response.statusCode, response.body).toBe(200);
                const value = UsageAnalyticsQueryResponseSchema.parse(response.json());
                expect(value.totals).toMatchObject({ eventCount: 0, tokens: { total: null } });
                expect(value.breakdowns?.model).toEqual([]);
            }
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query-batch', headers, payload: { queries } });
            expect(response.statusCode, response.body).toBe(200);
            const batch = UsageAnalyticsQueryBatchResponseSchema.parse(response.json());
            expect(batch.results).toHaveLength(3);
            for (const row of batch.results) {
                expect(row).not.toHaveProperty('error');
                if ('value' in row) expect(row.value.totals).toMatchObject({ eventCount: 0, tokens: { total: null } });
            }
        });
    });

    it('delivers aggregate slices without raw rows and pages only explicitly requested contribution detail', async () => {
        const account = await db.account.create({ data: { publicKey: 'pk-usage-slice-delivery', encryptionMode: 'plain' }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'usage-slice-delivery',
            encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const query = usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { startMs: 0, endMs: 1000 },
            includeSessionEvidence: false, includeWorkEvidence: false, topLimit: 2, breakdown: ['agent'] }));
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { 'x-test-user-id': account.id };
            for (let index = 0; index < 5; index++) {
                const ingested = await app.inject({ method: 'POST', url: '/v2/usage-events', headers,
                    payload: { sessionId: session.id, observedAt: 100 + index, agentId: 'codex', source: 'runtime', scope: 'turn_delta', isCumulative: false,
                        modelId: 'gpt-5.4', tokens: { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
                        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
                expect(ingested.statusCode, ingested.body).toBe(200);
            }
            const read = (contributionQueries: typeof query[], contributionOffset = 0) => app.inject({ method: 'POST',
                url: '/v2/usage/query-batch', headers, payload: { queries: [query], contributionQueries, contributionOffset } });
            const compact = await read([]);
            expect(compact.statusCode, compact.body).toBe(200);
            const summary = UsageAnalyticsQueryBatchResponseSchema.parse(compact.json());
            expect(summary.results[0]).toMatchObject({ value: { totals: { eventCount: 5, tokens: { total: 50 } } } });
            expect(summary.results[0]).not.toHaveProperty('value.contributions');
            expect(summary).not.toHaveProperty('contributionPages');
            const rows: string[] = [];
            let offset: number | null = 0;
            while (offset !== null) {
                const response = await read([query], offset);
                expect(response.statusCode, response.body).toBe(200);
                const body = response.json() as { contributionPages: { rows: { id: string }[]; offset: number;
                    totalCount: number; nextOffset: number | null }[]; results: unknown[] };
                expect(body.results[0]).not.toHaveProperty('value.contributions');
                const page = body.contributionPages[0]!;
                expect(page.totalCount).toBe(5);
                expect(page.offset).toBe(offset);
                expect(page.rows.length).toBeLessThanOrEqual(query.topLimit);
                rows.push(...page.rows.map(row => row.id));
                offset = page.nextOffset;
            }
            expect(rows).toHaveLength(5);
            expect(new Set(rows).size).toBe(5);
            const streamed = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { ...headers, accept: 'application/x-ndjson' }, payload: { queries: [query], contributionQueries: [query] } });
            expect(streamed.statusCode).toBe(200);
            const streamedBody: string = streamed.body;
            const chunks = streamedBody.trim().split('\n').map(line => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(line)));
            expect(chunks.flatMap(chunk => chunk.results)).toHaveLength(1);
            expect(chunks.flatMap(chunk => chunk.contributionPages ?? []).map(page => page.rows.length)).toEqual([2, 2, 1]);
            const workStream = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { ...headers, accept: 'application/x-ndjson; contribution-projection=work' },
                payload: { queries: [query], contributionQueries: [query] } });
            expect(workStream.statusCode).toBe(200);
            const workStreamBody: string = workStream.body;
            const workChunks = workStreamBody.trim().split('\n').map(line => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(line)));
            const fullRows = chunks.flatMap(chunk => chunk.contributionPages?.flatMap(page => page.rows) ?? []);
            const workRows = workChunks.flatMap(chunk => chunk.contributionPages?.flatMap(page => page.rows) ?? []);
            expect(workRows).toEqual(fullRows.map(row => {
                const { context: _context, connectedAccount: _account, providerConnectionId: _connection,
                    providerAttribution: _attribution, providerSource: _source, ...work } = row;
                return work;
            }));
            expect(JSON.stringify(workRows).length).toBeLessThan(JSON.stringify(fullRows).length);
            const dictionaryStream = await app.inject({ method: 'POST', url: '/v2/usage/query-batch',
                headers: { ...headers, accept: 'application/x-ndjson; contribution-projection=work; contribution-encoding=dictionary' },
                payload: { queries: [query], contributionQueries: [query] } });
            expect(dictionaryStream.statusCode).toBe(200);
            const dictionaryStreamBody: string = dictionaryStream.body;
            const dictionaryChunks = dictionaryStreamBody.trim().split('\n')
                .map(line => UsageAnalyticsQueryBatchResponseSchema.parse(JSON.parse(line)));
            expect(dictionaryChunks).toEqual(workChunks);
            expect(dictionaryStream.body.length).toBeLessThan(workStream.body.length);
        });
    });

    it("keeps shared-session usage viewer-bound and retires the read when the grant is removed", async () => {
        const [owner, reader, outsider] = await Promise.all(["owner", "reader", "outsider"].map(role =>
            db.account.create({ data: { publicKey: `pk-usage-shared-${role}`, encryptionMode: "plain" }, select: { id: true } })));
        const session = await db.session.create({ data: { accountId: owner.id, tag: "usage-shared",
            encryptionMode: "plain", metadata: "{}" }, select: { id: true } });
        await db.sessionShare.create({ data: { sessionId: session.id, sharedByUserId: owner.id,
            sharedWithUserId: reader.id, accessLevel: "view", canApprovePermissions: false } });
        await db.usageEvent.create({ data: { accountId: owner.id, sessionId: session.id, observedAt: new Date(1000),
            agentId: "claude", source: "runtime", scope: "turn_delta", inputTokens: 10, totalTokens: 10 } });
        await db.sessionMessage.create({ data: { sessionId: session.id, seq: 1, content: { t: "plain", v: {} } } });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const query = (accountId: string) => app.inject({ method: "POST", url: "/v2/usage/query",
                headers: { "content-type": "application/json", "x-test-user-id": accountId },
                payload: { filters: { sessionIds: [session.id] }, includeMessageStats: true, includeInsights: true } });
            expect((await query(owner.id)).json().totals.tokens.total).toBe(10);
            const shared = await query(reader.id);
            expect(shared.statusCode).toBe(200);
            expect(shared.json()).toMatchObject({ totals: { eventCount: 0, tokens: { total: null } },
                messageStats: { sessionCount: 0, messageCount: 0 } });
            const legacy = await app.inject({ method: "POST", url: "/v1/usage/query",
                headers: { "content-type": "application/json", "x-test-user-id": reader.id },
                payload: { sessionId: session.id } });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json().usage).toEqual([]);
            expect((await query(outsider.id)).statusCode).toBe(404);
            await db.sessionShare.deleteMany({ where: { sessionId: session.id } });
            expect((await query(reader.id)).statusCode).toBe(404);
        });
    });

    it("keeps adjacent v2 ranges disjoint while translating the retained inclusive v1 end", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-query-boundary" }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: account.id, tag: "query-boundary",
            encryptionMode: "e2ee", metadata: "ciphertext" }, select: { id: true } });
        await db.usageEvent.createMany({ data: [
            { observedAt: new Date(999), totalTokens: 5, inputTokens: 5 },
            { observedAt: new Date(1000), totalTokens: 10, inputTokens: 10 },
            { observedAt: new Date(2000), totalTokens: 20, inputTokens: 20 },
        ].map(event => ({ ...event, accountId: account.id, sessionId: session.id, agentId: "claude", source: "runtime",
            scope: "turn_delta", isCumulative: false })) });
        await db.sessionMessage.createMany({ data: [999, 1000, 2000].map((instant, seq) => ({
            sessionId: session.id, seq: seq + 1, content: { t: "encrypted", c: "ciphertext" }, createdAt: new Date(instant),
        })) });
        await withAuthenticatedTestApp(accountRoutes, async app => {
            const headers = { "content-type": "application/json", "x-test-user-id": account.id };
            const previous = await app.inject({ method: "POST", url: "/v2/usage/query", headers,
                payload: { filters: { sessionIds: [session.id] }, dateRange: { startMs: 0, endMs: 1000 }, includeMessageStats: true } });
            const current = await app.inject({ method: "POST", url: "/v2/usage/query", headers,
                payload: { filters: { sessionIds: [session.id] }, dateRange: { startMs: 1000, endMs: 2000 }, includeMessageStats: true } });
            expect(previous.statusCode).toBe(200);
            expect(current.statusCode).toBe(200);
            expect(previous.json().totals.tokens.total).toBe(5);
            expect(current.json().totals.tokens.total).toBe(10);
            expect(previous.json().messageStats.messageCount).toBe(1);
            expect(current.json().messageStats.messageCount).toBe(1);
            const batched = await app.inject({ method: 'POST', url: '/v2/usage/query-batch', headers,
                payload: { queries: [
                    { filters: { sessionIds: [session.id] }, dateRange: { startMs: 0, endMs: 1000 }, includeMessageStats: true },
                    { filters: { sessionIds: [session.id] }, dateRange: { startMs: 1000, endMs: 2000 }, includeMessageStats: true },
                    { filters: { sessionIds: ['unreadable-session'] }, dateRange: { startMs: 0, endMs: 2000 } },
                ] } });
            expect(batched.statusCode, batched.body).toBe(200);
            expect(batched.json().results.map((result: { value?: unknown; error?: string }) => result.value ?? result.error))
                .toEqual([expect.objectContaining({ totals: expect.objectContaining({ tokens: expect.objectContaining({ total: 5 }) }),
                    messageStats: { sessionCount: 1, messageCount: 1 } }),
                expect.objectContaining({ totals: expect.objectContaining({ tokens: expect.objectContaining({ total: 10 }) }),
                    messageStats: { sessionCount: 1, messageCount: 1 } }), 'not_found']);
            expect(batched.json()).not.toHaveProperty('priceCatalog');
            expect(batched.json().results[0].value).not.toHaveProperty('contributions');
            const legacy = await app.inject({ method: "POST", url: "/v1/usage/query", headers,
                payload: { sessionId: session.id, endTime: 1, groupBy: "day" } });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json().usage.map((bucket: { tokens: { total: number } }) => bucket.tokens.total)).toEqual([15]);
        });
    });

    it("queries authenticated period truth after baseline, model switch and correlated replay", async () => {
        const account = await db.account.create({ data: { publicKey: "pk-u0-authenticated-truth" }, select: { id: true } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: "u0-authenticated-truth", encryptionMode: "e2ee", metadata: "ciphertext",
        }, select: { id: true } });
        await withAuthenticatedTestApp(accountRoutes, async (app) => {
            const headers = { "content-type": "application/json", "x-test-user-id": account.id };
            const observations = [
                { observedAt: Date.parse("2026-07-01T10:00:00Z"), scope: "session_cumulative", modelId: "A", total: 100, source: "runtime" },
                { observedAt: Date.parse("2026-07-02T10:00:00Z"), scope: "turn_delta", modelId: "A", total: 10, source: "runtime", inferenceId: "a", turnId: "a" },
                { observedAt: Date.parse("2026-07-02T10:00:00Z"), scope: "turn_delta", modelId: "A", total: 10, source: "native", inferenceId: "a", turnId: "a" },
                { observedAt: Date.parse("2026-07-02T11:00:00Z"), scope: "turn_delta", modelId: "B", total: 10, source: "runtime", inferenceId: "b", turnId: "b" },
                { observedAt: Date.parse("2026-07-02T12:00:00Z"), scope: "session_final", modelId: "B", total: 120, source: "native" },
            ];
            for (const [index, observation] of observations.entries()) {
                const payload = {
                    sessionId: session.id, observedAt: observation.observedAt,
                    agentId: "codex", modelId: observation.modelId, source: observation.source,
                    scope: observation.scope, isCumulative: observation.scope !== "turn_delta",
                    externalKey: `u0-${index}`, turnId: observation.turnId,
                    tokens: { input: observation.total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: observation.total },
                    cost: { reportedUsd: 0, estimatedUsd: observation.total / 1000, costSource: "pricing_estimate", currency: "USD" },
                    metadata: { usageAccounting: { path: observation.source, status: "partial", inferenceId: observation.inferenceId } },
                };
                const result = await app.inject({ method: "POST", url: "/v2/usage-events", headers, payload });
                expect(result.statusCode).toBe(200);
                const replay = await app.inject({ method: "POST", url: "/v2/usage-events", headers, payload });
                expect(replay.statusCode).toBe(200);
                expect(replay.json()).toEqual(result.json());
            }
            const query = await app.inject({ method: "POST", url: "/v2/usage/query", headers, payload: {
                dateRange: { startMs: Date.parse("2026-07-02T00:00:00Z"), endMs: Date.parse("2026-07-03T00:00:00Z") },
                filters: { sessionIds: [session.id] }, breakdowns: ["model", "source"], includeSeries: true,
            } });
            expect(query.statusCode).toBe(200);
            expect(query.json()).toMatchObject({ totals: { tokens: { total: 20 } },
                breakdowns: { model: expect.arrayContaining([
                    expect.objectContaining({ key: "A", tokens: expect.objectContaining({ total: 10 }) }),
                    expect.objectContaining({ key: "B", tokens: expect.objectContaining({ total: 10 }) }),
                ]) }, coverage: { status: "partial" },
            });
            const filtered = await app.inject({ method: "POST", url: "/v2/usage/query", headers, payload: {
                dateRange: { startMs: Date.parse("2026-07-02T00:00:00Z") },
                filters: { sessionIds: [session.id], modelIds: ["A"], sources: ["runtime"] },
            } });
            expect(filtered.statusCode).toBe(200);
            expect(filtered.json().totals.tokens.total).toBe(10);
            const legacy = await app.inject({ method: "POST", url: "/v1/usage/query", headers, payload: {
                sessionId: session.id, startTime: Date.parse("2026-07-02T00:00:00Z") / 1000,
                endTime: Date.parse("2026-07-03T00:00:00Z") / 1000, groupBy: "day",
            } });
            expect(legacy.statusCode).toBe(200);
            expect(legacy.json().usage.map((row: { tokens: { total: number } }) => row.tokens.total)).toEqual([20]);
            const unauthenticated = await app.inject({ method: "POST", url: "/v2/usage/query", payload: {} });
            expect(unauthenticated.statusCode).toBe(401);
        });
    });

    it("upserts usage report and emits ephemeral when sessionId is provided", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-upsert" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-session",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "k1",
                        sessionId: session.id,
                        tokens: { total: 10, prompt: 5 },
                        cost: { total: 0.1 },
                    },
                });

                expect(res.statusCode).toBe(200);
                expect(res.json()).toMatchObject({
                    success: true,
                    reportId: expect.any(String),
                    createdAt: expect.any(Number),
                    updatedAt: expect.any(Number),
                });
            },
        );

        const stored = await db.usageReport.findUnique({
            where: {
                accountId_sessionId_key: {
                    accountId: account.id,
                    sessionId: session.id,
                    key: "k1",
                },
            },
            select: { id: true, data: true },
        });
        expect(stored).toEqual(
            expect.objectContaining({
                id: expect.any(String),
                data: { tokens: { total: 10, prompt: 5 }, cost: { total: 0.1 } },
            }),
        );
        const deliveries = emitEphemeral.mock.calls.map(([delivery]) => ({
            ...delivery,
            payload: EphemeralUpdateSchema.parse(delivery.payload),
        }));
        expect(deliveries).toEqual([{
            userId: account.id,
            recipientFilter: { type: "user-scoped-only" },
            payload: { type: "usage", id: session.id, key: "k1", tokens: { total: 10, prompt: 5 },
                cost: { total: 0.1 }, timestamp: expect.any(Number), accountingChange: { sessionId: session.id } },
        }]);
    });

    it("returns 404 when sessionId does not belong to user", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-missing-session" },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                const res = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: { key: "k1", sessionId: "missing-session", tokens: { total: 1 }, cost: { total: 1 } },
                });

                expect(res.statusCode).toBe(404);
                expect(res.json()).toEqual({ error: "Session not found" });
            },
        );

        expect(emitEphemeral).not.toHaveBeenCalled();
        expect(await db.usageReport.count()).toBe(0);
    });

    it("preserves legacy usage-report writes while exposing delta-based totals through v2 analytics", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-legacy-bridge" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-legacy-bridge",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                const first = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-k1",
                        sessionId: session.id,
                        tokens: { total: 10, input: 6, output: 4 },
                        cost: { total: 0.1 },
                    },
                });
                expect(first.statusCode).toBe(200);

                const second = await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-k1",
                        sessionId: session.id,
                        tokens: { total: 15, input: 9, output: 6 },
                        cost: { total: 0.15 },
                    },
                });
                expect(second.statusCode).toBe(200);

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        filters: { sessionIds: [session.id] },
                        includeSeries: true,
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 2,
                        tokens: { total: 15, input: 9, output: 6 },
                        cost: { reportedUsd: 0.15, estimatedUsd: null, currency: "USD" },
                    },
                });
            },
        );
    });

    it("treats decreased legacy cumulative snapshots as a fresh baseline delta", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-legacy-reset" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-legacy-reset",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-reset-k1",
                        sessionId: session.id,
                        tokens: { total: 20, input: 12, output: 8 },
                        cost: { total: 0.2 },
                    },
                });

                await app.inject({
                    method: "POST",
                    url: "/v2/usage-reports",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        key: "legacy-reset-k1",
                        sessionId: session.id,
                        tokens: { total: 5, input: 3, output: 2 },
                        cost: { total: 0.05 },
                    },
                });

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        filters: { sessionIds: [session.id] },
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    totals: {
                        eventCount: 2,
                        tokens: { total: 25, input: 15, output: 10 },
                        cost: { reportedUsd: 0.25, estimatedUsd: null, currency: "USD" },
                    },
                });
            },
        );
    });

    it("accepts append-only usage events and returns structured v2 breakdowns", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-events-v2" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-v2",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                const ingest = await app.inject({
                    method: "POST",
                    url: "/v2/usage-events",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        sessionId: session.id,
                        observedAt: 1_714_000_000_000,
                        agentId: "claude",
                        backendMode: "remote",
                        modelId: "claude-sonnet-4-6",
                        projectKey: "project:abc",
                        workspaceId: "workspace-1",
                        machineId: "machine-1",
                        source: "claude_sdk",
                        scope: "turn_delta",
                        externalKey: "vendor-1",
                        turnId: "turn-1",
                        isCumulative: false,
                        tokens: {
                            input: 10,
                            output: 5,
                            reasoning: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 15,
                        },
                        cost: {
                            reportedUsd: 0.12,
                            estimatedUsd: 0,
                            currency: "USD",
                        },
                        context: {
                            usedTokens: 15,
                            windowTokens: 200000,
                        },
                    },
                });

                expect(ingest.statusCode).toBe(200);
                expect(ingest.json()).toMatchObject({
                    success: true,
                    eventId: expect.any(String),
                });
                const delivery = emitEphemeral.mock.calls[0]?.[0];
                expect(delivery).toMatchObject({
                    userId: account.id,
                    recipientFilter: { type: "user-scoped-only" },
                });
                expect(EphemeralUpdateSchema.parse(delivery?.payload)).toEqual({
                    type: "usage",
                    id: session.id,
                    key: "claude:claude-sonnet-4-6",
                    accountingChange: { sessionId: session.id, observedFromMs: 1_714_000_000_000 },
                    tokens: {
                        total: 15,
                        input: 10,
                        output: 5,
                        reasoning: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    cost: {
                        total: 0.12,
                        reportedUsd: 0.12,
                        estimatedUsd: 0,
                    },
                    timestamp: expect.any(Number),
                });

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        breakdowns: ["agent", "model"],
                        filters: { sessionIds: [session.id], agentIds: ["claude"] },
                        includeSeries: true,
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 1,
                        tokens: { total: 15 },
                        cost: { reportedUsd: 0.12, estimatedUsd: 0, currency: "USD" },
                    },
                    breakdowns: {
                        agent: [
                            expect.objectContaining({
                                key: "claude",
                                eventCount: 1,
                                tokens: expect.objectContaining({ total: 15 }),
                            }),
                        ],
                        model: [
                            expect.objectContaining({
                                key: "claude-sonnet-4-6",
                                eventCount: 1,
                                tokens: expect.objectContaining({ total: 15 }),
                            }),
                        ],
                    },
                });
            },
        );
    });

    it("returns additive insights, activity, leaders, and cost presentation for premium analytics queries", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-account-usage-events-premium" },
            select: { id: true },
        });
        const sessionA = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-premium-a",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });
        const sessionB = await db.session.create({
            data: {
                accountId: account.id,
                tag: "usage-events-premium-b",
                encryptionMode: "e2ee",
                metadata: "ciphertext",
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                seq: 0,
                pendingVersion: 0,
                pendingCount: 0,
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            accountRoutes,
            async (app) => {
                const events = [
                    {
                        sessionId: sessionA.id,
                        observedAt: Date.UTC(2024, 3, 25, 13, 0, 0),
                        agentId: "claude",
                        backendMode: "remote",
                        modelId: "claude-sonnet-4-6",
                        source: "claude_sdk",
                        externalKey: "premium-1",
                        tokens: { input: 12, output: 6, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 18 },
                        cost: { reportedUsd: 0.18, estimatedUsd: 0.11, invoiceUsd: 0.09, billingContext: "api_usage", costSource: "provider_reported", currency: "USD" },
                    },
                    {
                        sessionId: sessionB.id,
                        observedAt: Date.UTC(2024, 3, 26, 14, 0, 0),
                        agentId: "codex",
                        backendMode: "appServer",
                        modelId: "gpt-5-codex",
                        source: "codex_app_server",
                        externalKey: "premium-2",
                        tokens: { input: 20, output: 10, reasoning: 2, cacheRead: 3, cacheWrite: 0, total: 33 },
                        cost: { reportedUsd: 0, estimatedUsd: 0.21, invoiceUsd: 0, billingContext: "unknown", costSource: "pricing_estimate", currency: "USD" },
                    },
                ] as const;

                for (const event of events) {
                    const ingest = await app.inject({
                        method: "POST",
                        url: "/v2/usage-events",
                        headers: { "content-type": "application/json", "x-test-user-id": account.id },
                        payload: {
                            ...event,
                            projectKey: "project:premium",
                            workspaceId: "workspace-premium",
                            machineId: "machine-premium",
                            scope: "turn_delta",
                            turnId: null,
                            isCumulative: false,
                            context: {
                                usedTokens: event.tokens.total,
                                windowTokens: 200000,
                            },
                        },
                    });

                    expect(ingest.statusCode).toBe(200);
                }

                const query = await app.inject({
                    method: "POST",
                    url: "/v2/usage/query",
                    headers: { "content-type": "application/json", "x-test-user-id": account.id },
                    payload: {
                        granularity: "day",
                        costMode: "estimated",
                        includeSeries: true,
                        includeInsights: true,
                        includeActivity: true,
                        includeLeaders: true,
                        includeModelTimeline: true,
                        includeMessageStats: true,
                        activityResolution: "both",
                        breakdowns: ["agent", "model", "session"],
                    },
                });

                expect(query.statusCode).toBe(200);
                expect(query.json()).toMatchObject({
                    v: 1,
                    totals: {
                        eventCount: 2,
                        tokens: { total: 51 },
                        cost: {
                            reportedUsd: 0.18,
                            estimatedUsd: 0.32,
                            invoiceUsd: 0.09,
                            currency: "USD",
                        },
                    },
                    insights: {
                        activeDays: 2,
                        longestStreakDays: 2,
                        sessionsUsed: 2,
                        modelsTried: 2,
                        favoriteModelChangeCount: 1,
                    },
                    activity: {
                        calendarDays: [
                            expect.objectContaining({ date: "2024-04-25", eventCount: 1 }),
                            expect.objectContaining({ date: "2024-04-26", eventCount: 1 }),
                        ],
                        weekdayHourBuckets: [
                            expect.objectContaining({ weekday: 4, hour: 13, eventCount: 1 }),
                            expect.objectContaining({ weekday: 5, hour: 14, eventCount: 1 }),
                        ],
                    },
                    leaders: {
                        agents: expect.arrayContaining([
                            expect.objectContaining({ key: "codex", eventCount: 1 }),
                            expect.objectContaining({ key: "claude", eventCount: 1 }),
                        ]),
                        engines: expect.arrayContaining([
                            expect.objectContaining({ key: "claude:remote", eventCount: 1 }),
                            expect.objectContaining({ key: "codex:appServer", eventCount: 1 }),
                        ]),
                    },
                    messageStats: {
                        sessionCount: 2,
                    },
                    costPresentation: {
                        mode: "estimated",
                        effectiveUsd: 0.32,
                        currency: "USD",
                    },
                });
            },
        );
    });
});
