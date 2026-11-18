import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../../server/sources/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../server/sources/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../../server/sources/app/api/testkit/sqliteFastify';
import { registerAccountUsageRoutes } from '../../../server/sources/app/api/routes/account/registerAccountUsageRoutes';
import { registerAccountEncryptionRoutes } from '../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { kvRoutes } from '../../../server/sources/app/api/routes/kv/kvRoutes';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { UsageQueryAccountContext } from '../sync/api/account/usageQueryResource';
import type { AuthCredentials } from '../auth/storage/tokenStorage';
import { upsertServerProfile } from '../sync/domains/server/serverProfiles';
import { seedUsageRigAccountingRows, USAGE_RIG_NOW, USAGE_RIG_DAY } from './testkit/fixtures/usageRigAccounting';
import { createRootLayoutFeaturesResponse } from './testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '../sync/api/capabilities/serverFeaturesClient';

// These are the six original failed requests, deliberately kept separate from
// the mounted-preset matrix. Models were not requested by any of these cells.
const ORIGINAL_FAILURES = [
    { view: 'Work', breakdown: ['project', 'session'] as const },
    { view: 'How you work', breakdown: ['agent'] as const },
    { view: 'Sources', breakdown: ['source'] as const },
];
const PERIODS = [{ id: 'Month', days: 30 }, { id: 'Year', days: 365 }];

type RequestObservation = Readonly<{ path: string; status: number; bytes: number; elapsedMs: number }>;

function makeContext(accountId: string, request: UsageQueryAccountContext['request'], serverId: string): UsageQueryAccountContext {
    const credentials: AuthCredentials = { token: accountId };
    const lifetime = {
        scope: { serverId, accountId },
        isCurrent: () => true,
        onRetire: () => ({ dispose() {} }),
    };
    // A scoped read transport keeps the real Resource owner on this exact test
    // lifetime while its read delegates to Fastify's injected HTTP boundary.
    return { credentials, accountLifetime: lifetime, request,
        readTransport: { scope: {}, serverId, key: `usage-rig:${accountId}`, read: async (path, init, _options, consume) => consume(await request(path, init)) } };
}


describe('Usage RIG: production-scale client/server data path', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-rig-', initAuth: false }); }, 120_000);
    afterAll(async () => { resetServerFeaturesClientForTests(); if (harness) await harness.close(); });

    it('distinguishes unrequested model breakdowns from field loss for every original failing cell', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
        const claudeSession = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-claude', encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const codexSession = await db.session.create({ data: { accountId: account.id, tag: 'usage-rig-codex', encryptionMode: 'plain', metadata: '{}' }, select: { id: true } });
        const rows = seedUsageRigAccountingRows(account.id, claudeSession.id, codexSession.id);
        for (let offset = 0; offset < rows.length; offset += 1_000) await db.usageEvent.createMany({ data: rows.slice(offset, offset + 1_000) });
        const observations: RequestObservation[] = [];
        const failures: Array<Record<string, unknown>> = [];
        const table: Array<Record<string, unknown>> = [];

        await withAuthenticatedTestApp(app => {
            registerAccountUsageRoutes(app);
            registerAccountEncryptionRoutes(app);
            kvRoutes(app);
        }, async app => {
            const { readUiUsageQueryBatch } = await import('../sync/api/account/usageQueryResource');
            const request: UsageQueryAccountContext['request'] = async (path, init) => {
                const started = performance.now();
                const bodyValue = init ? init.body : undefined;
                const body = bodyValue == null ? undefined : String(bodyValue);
                const response = await app.inject({ method: init?.method ?? 'GET', url: path,
                    headers: { 'x-test-user-id': account.id, ...(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}) },
                    ...(body === undefined ? {} : { payload: body }) });
                const elapsedMs = performance.now() - started;
                observations.push({ path, status: response.statusCode, bytes: Buffer.byteLength(response.body), elapsedMs });
                const headers = new Headers();
                for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, String(value));
                return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers });
            };
            const profile = await upsertServerProfile({ serverUrl: 'http://usage-rig.test', name: 'Usage RIG', source: 'manual' });
            const context = makeContext(account.id, request, profile.id);
            primeServerFeaturesSnapshot({ serverId: profile.id, snapshot: { status: 'ready',
                features: createRootLayoutFeaturesResponse({ features: { usage: { compactBatch: { enabled: true } } } }) } });
            for (const view of ORIGINAL_FAILURES) for (const period of PERIODS) {
                for (const modelControl of [false, true]) {
                    const cell = `${view.view}/${period.id}/${modelControl ? 'model-control' : 'original'}`;
                    const query = normalizeUsageQuery({
                        period: { startMs: USAGE_RIG_NOW - period.days * USAGE_RIG_DAY, endMs: USAGE_RIG_NOW + 1 },
                        metric: 'tokens', costBasis: 'auto', includeComparison: false,
                        includeSeries: false, includeInsights: false, includeActivity: false,
                        includeModelTimeline: false, includeMessageStats: false,
                        includeSessionEvidence: false, includeTranscriptEvidence: false,
                        includeCoach: false, includeWorkEvidence: false,
                        includeQuota: false, includeQuotaHistory: false,
                        breakdown: modelControl ? [...view.breakdown, 'model'] : [...view.breakdown],
                    });
                    const before = observations.length;
                    const started = performance.now();
                    try {
                        // One query per acquisition: grouped requests and prior Resource
                        // results cannot mask a single-cell producer/reader field loss.
                        const batch = await readUiUsageQueryBatch(context, { queries: [query] });
                        const slice = batch.results.find(item => item.key === getUsageQueryKey(query));
                        expect(slice?.pending, cell).toBe(false);
                        expect(slice?.errorCode, cell).toBeUndefined();
                        const decoded = UsageAnalyticsQueryResponseSchema.parse(slice?.accounting);
                        expect(decoded.totals.eventCount, cell).toBe(rows.length);
                        const expectedTotal = rows.reduce((sum, row) => sum + row.totalTokens, 0);
                        expect(decoded.totals.tokens.total, cell).toBe(expectedTotal);
                        // Every requested dimension partitions the complete fixture.
                        // No synthetic residual can make a missing category pass.
                        for (const dimension of query.breakdown) {
                            const groups = decoded.breakdowns?.[dimension] ?? [];
                            expect(groups.length, `${cell}/${dimension}`).toBe(2);
                            for (const category of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const) {
                                expect(groups.reduce((sum, group) => sum + (group.tokens[category] ?? 0), 0), `${cell}/${dimension}/${category}`)
                                    .toBe(decoded.totals.tokens[category]);
                            }
                        }
                        const models = decoded.breakdowns?.model;
                        if (modelControl) expect(models?.map(row => row.key).sort(), cell).toEqual(['claude-3-5-sonnet', 'gpt-5-mini']);
                        else expect(models, `${cell}: response honors requested dimensions`).toBeUndefined();
                        const requests = observations.slice(before);
                        expect(requests.filter(row => row.path === '/v2/usage/query-batch').length, cell).toBe(1);
                        table.push({ cell, requestedDimensions: query.breakdown, returnedDimensions: Object.keys(decoded.breakdowns ?? {}),
                            bytes: requests.reduce((sum, row) => sum + row.bytes, 0), requests: requests.length,
                            seconds: (performance.now() - started) / 1000, eventCount: decoded.totals.eventCount,
                            verdict: modelControl ? 'requested models and token categories preserved' : 'unrequested model correctly omitted' });
                    } catch (error) {
                        failures.push({ cell, error: error instanceof Error ? error.message : String(error), requests: observations.slice(before) });
                    }
                }
            }
            const refusal = await request('/v2/usage/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filters: { sessionIds: ['missing-usage-rig-session'] } }) });
            if (refusal.status !== 404) failures.push({ cell: 'typed-refusal/missing-session', error: `status:${refusal.status}` });
            const zero = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' }, select: { id: true } });
            const zeroResponse = await app.inject({ method: 'POST', url: '/v2/usage/query', headers: { 'x-test-user-id': zero.id }, payload: { includeSeries: true } });
            if (zeroResponse.statusCode !== 200 || UsageAnalyticsQueryResponseSchema.parse(zeroResponse.json()).totals.eventCount !== 0) failures.push({ cell: 'zero-summary-account', error: `status:${zeroResponse.statusCode}` });
        });
        console.info(JSON.stringify({ scope: 'six original single-cell model-category failures plus six requested-model controls',
            excludes: ['mounted preset matrix', 'provider quota history', 'reconnect lifecycle'],
            fixture: { usageEvents: rows.length, claudeEvents: 8500, claudeDays: 13, codexEvents: 36500, codexDays: 22 }, table, failures }));
        expect(failures, JSON.stringify({ table, failures })).toEqual([]);
    }, 600_000);
});
