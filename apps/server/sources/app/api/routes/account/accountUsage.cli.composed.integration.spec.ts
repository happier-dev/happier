import Fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    createActionExecutor,
    getActionSpec,
    getUsageQueryKey,
    normalizeUsageQuery,
    UsageAnalyticsQueryResponseSchema,
    UsageEventIngestRequestSchema,
    UsageQueryBatchResultSchema,
    type ActionExecutorDeps,
    type UsageEventIngestRequest,
} from '@happier-dev/protocol';

import { auth } from '@/app/auth/auth';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { accountRoutes } from './accountRoutes';

async function importCliSource<T>(specifier: string): Promise<T> {
    // The existing server composed harness resolves each workspace's real source
    // aliases; production server compilation remains rooted in this package.
    return import(specifier) as Promise<T>;
}

describe('usage.query CLI HTTP → Account routes → SQLite accounting', () => {
    let harness: LightSqliteHarness;
    let app: FastifyInstance;
    let origin: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-usage-cli-',
            initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: 'false' },
        });
        app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        const api = app as unknown as AppFastify;
        enableErrorHandlers(api);
        enableAuthentication(api);
        accountRoutes(api);
        origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }, 120_000);

    afterAll(async () => {
        await app?.close();
        await harness?.close();
    });

    it('preserves partial unpriced producer facts in distinct keyed batches and refuses retired credentials', async () => {
        const account = await db.account.create({ data: {
            publicKey: randomBytes(32).toString('hex'), encryptionMode: 'plain',
        } });
        const otherAccount = await db.account.create({ data: {
            publicKey: randomBytes(32).toString('hex'), encryptionMode: 'plain',
        } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: 'cli-usage', encryptionMode: 'plain', metadata: '{}',
        } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const foreignToken = await auth.createToken(otherAccount.id, undefined, { kind: 'account', authority: 'present_user' });
        const { buildUsageEventIngestRequest } = await importCliSource<{
            buildUsageEventIngestRequest: (input: unknown) => UsageEventIngestRequest | null;
        }>('../../../../../../cli/src/usage/buildUsageEventIngestRequest');
        const { createAccountServerActionDeps } = await importCliSource<{
            createAccountServerActionDeps: (input: Readonly<{
                token: string; credentials: Readonly<{ token: string; encryption: null }>;
                serverId: string; serverHttpBaseUrl: string; isCredentialCurrent: () => boolean;
            }>) => Pick<ActionExecutorDeps, 'usageActions'>;
        }>('../../../../../../cli/src/api/accountServerActionDeps');
        const { createUnavailableActionTransportDeps } = await importCliSource<{
            createUnavailableActionTransportDeps: () => ActionExecutorDeps;
        }>('../../../../../../cli/src/testkit/actionTransportDeps');

        const observedAt = Date.parse('2026-10-01T12:00:00Z');
        for (const [index, total] of [12, 7].entries()) {
            const produced = buildUsageEventIngestRequest({ sessionId: session.id,
                observedAt: observedAt + index, externalKey: `cli-usage-${index}`, turnId: `turn-${index}`,
                observation: { provider: 'codex', source: 'native', scope: 'turn_delta', key: null,
                    modelId: `unpriced-cli-model-${index}`, tokens: { input: total, total }, cost: null,
                    contextUsedTokens: null, contextWindowTokens: null },
                metadata: { usageAccounting: { path: 'native', status: 'partial', historyComplete: false } },
            });
            const payload = UsageEventIngestRequestSchema.parse(produced);
            const response = await fetch(`${origin}/v2/usage-events`, {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify(payload),
            });
            expect(response.status, JSON.stringify(await response.json())).toBe(200);
        }
        expect(await db.usageEvent.count({ where: { accountId: account.id } })).toBe(2);

        let current = true;
        const makeExecutor = (bearer: string) => createActionExecutor({
            ...createUnavailableActionTransportDeps(),
            ...createAccountServerActionDeps({
            token: bearer, credentials: { token: bearer, encryption: null },
            serverId: 'usage-home', serverHttpBaseUrl: origin, isCredentialCurrent: () => current,
            }),
        });
        const executor = makeExecutor(token);
        const all = normalizeUsageQuery({ period: { startMs: observedAt - 1, endMs: observedAt + 2 },
            session: session.id, includeSessionEvidence: false, includeWorkEvidence: false });
        const filtered = normalizeUsageQuery({ ...all, modelIds: ['unpriced-cli-model-1'] });
        const input = getActionSpec('usage.query').inputSchema.parse({ queries: [all, filtered, all] });
        const result = await executor.execute('usage.query', input, { surface: 'cli', serverId: 'usage-home' });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const batch = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined);
        expect(getActionSpec('usage.query').outputSchema.safeParse(batch).success).toBe(true);
        expect(batch.results.map(slice => slice.key).sort()).toEqual([getUsageQueryKey(all), getUsageQueryKey(filtered)].sort());
        for (const [query, total] of [[all, 19], [filtered, 7]] as const) {
            const slice = batch.results.find(candidate => candidate.key === getUsageQueryKey(query))!;
            const accounting = UsageAnalyticsQueryResponseSchema.parse(slice.accounting);
            expect(accounting.totals.tokens.total).toBe(total);
            expect(accounting.costFacts).toContainEqual(expect.objectContaining({ kind: 'unpriced', amountUsd: null }));
            expect(accounting.coverage).toMatchObject({ status: 'partial', sources: [expect.objectContaining({
                source: 'native', path: 'native', status: 'partial', historyComplete: false,
            })] });
            expect(slice.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'available' }));
            expect(slice.sources).toContainEqual({ source: 'quota', status: 'unsupported', errorCode: 'no_connected_accounts' });
            expect(slice.quota).toBeUndefined();
            expect(slice.requestedQuery).toEqual(slice.shownQuery);
        }
        // Account ownership is checked by the real query route before aggregation.
        const denied = await makeExecutor(foreignToken).execute('usage.query', { queries: [all] }, { surface: 'cli', serverId: 'usage-home' });
        expect(denied.ok, JSON.stringify(denied)).toBe(true);
        const deniedSlice = UsageQueryBatchResultSchema.parse(denied.ok ? denied.result : undefined).results[0]!;
        expect(deniedSlice.accounting).toBeUndefined();
        expect(deniedSlice.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'error', errorCode: 'denied' }));
        current = false;
        expect(await executor.execute('usage.query', { queries: [all] }, { surface: 'cli', serverId: 'usage-home' }))
            .toMatchObject({ ok: false, errorCode: 'credential_scope_retired' });
    });
});
