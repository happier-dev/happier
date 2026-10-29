import Fastify from 'fastify';
import { serializerCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { installDbModuleMock } from '../testkit/dbMocks';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION } from '@happier-dev/protocol';

const transaction = vi.fn();
// Fail the database boundary, preserving real retry exhaustion and HTTP projection.
installDbModuleMock({ db: { $transaction: transaction } });
const { inTx } = await import('@/storage/inTx');
const { enableErrorHandlers } = await import('./enableErrorHandlers');
const { createAuthenticatedTestApp } = await import('../testkit/sqliteFastify');
const { registerExternalActionRoutes } = await import('../routes/actions/registerExternalActionRoutes');
const { pluginDataRoutes } = await import('../routes/plugins/data/pluginDataRoutes');

describe('HTTP transaction conflict projection', () => {
    afterEach(() => { vi.unstubAllEnvs(); transaction.mockReset(); });

    it.each([
        { driver: 'P2034', expected: 'database_transaction_conflict_exhausted', meta: undefined },
        { driver: 'P2010', expected: 'database_transaction_conflict_exhausted', meta: { code: '40001' } },
        { driver: 'P2010', expected: 'database_transaction_timeout',
            meta: { code: '57014', message: 'canceling statement due to statement timeout' } },
        { driver: 'P2010', expected: 'database_transaction_timeout',
            meta: { code: '55P03', message: 'canceling statement due to lock timeout' } },
        { driver: 'P2028', expected: 'database_transaction_timeout',
            meta: { error: 'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 15000 ms, however 15048 ms passed since the start of the transaction.' } },
        { driver: 'P2024', expected: 'database_connection_unavailable', meta: undefined },
        { driver: 'P1017', expected: 'database_connection_unavailable', meta: undefined },
        { driver: 'P1001', expected: 'database_connection_unavailable', meta: undefined },
        { driver: 'P1002', expected: 'database_connection_unavailable', meta: undefined },
        { driver: 'P2028', expected: 'database_connection_unavailable',
            meta: { error: 'Unable to start a transaction in the given time.' } },
    ])('preserves $driver as typed $expected through the external Action route error handler', async ({ driver, expected, meta }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        transaction.mockRejectedValue(Object.assign(new Error('private SQL contents'), { code: driver, ...(meta ? { meta } : {}) }));
        const app = createAuthenticatedTestApp();
        // Exercise the real transaction owner at Fastify's database-failure boundary;
        // no internal dispatcher is substituted and no native dispatch can run.
        app.addHook('preHandler', async () => { await inTx(async () => undefined); });
        registerExternalActionRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/actions/session.spawn_new',
                headers: { authorization: 'Bearer pat-secret', 'x-test-user-id': 'account-1',
                    'x-test-auth-token-kind': 'api_token', 'x-test-api-token-account-id': 'account-1',
                    'x-test-api-token-principal-id': 'principal-1', 'x-test-api-token-credential-id': 'credential-1' },
                payload: { v: 1, requestId: 'confirmed-rollback', input: {} },
            });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'invalid_request', code: expected,
                requestId: 'confirmed-rollback' });
            expect(ExternalActionHttpErrorSchema.safeParse(response.json()).success).toBe(true);
            expect(response.body).not.toContain('private');
        } finally { await app.close(); }
    });

    it('projects exhausted rollback once as typed 503 despite a narrow route response schema', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        transaction.mockRejectedValue(Object.assign(new Error('private SQL contents'), { code: 'P2034' }));
        const app = Fastify({ logger: false });
        app.setSerializerCompiler(serializerCompiler);
        const typed = app.withTypeProvider<ZodTypeProvider>();
        enableErrorHandlers(typed as Parameters<typeof enableErrorHandlers>[0]);
        typed.post('/conflicting-write', {
            schema: { response: { 200: z.object({ success: z.literal(true) }) } },
        }, async () => inTx(async () => ({ success: true as const })));
        try {
            const response = await app.inject({ method: 'POST', url: '/conflicting-write' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_transaction_conflict_exhausted', statusCode: 503 });
            expect(response.body).not.toContain('private SQL contents');
        } finally {
            await app.close();
        }
    });

    it.each(['P1017', 'P1001', 'P1002'])('projects %s on a controller read without replaying an unknown transaction outcome', async code => {
        transaction.mockRejectedValue(Object.assign(new Error('private connection diagnostic'), { code }));
        const app = Fastify({ logger: false });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.post('/v1/machines/managed/controller/current', async () => inTx(async () => ({ machine: {} })));
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/controller/current' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_connection_unavailable', statusCode: 503 });
            expect(response.body).not.toContain('private');
            expect(transaction).toHaveBeenCalledTimes(1);
        } finally { await app.close(); }
    });

    it.each(['mutate', 'forget'] as const)('preserves confirmed rollback through the real Collection %s route and shared consumer', async (operation) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        // Only the database boundary fails; admission, mutation owner, global
        // error handler and strict client refusal parser all remain real.
        transaction.mockRejectedValue(Object.assign(new Error('private SQL contents'), { code: 'P2034' }));
        const app = createAuthenticatedTestApp();
        pluginDataRoutes(app);
        try {
            const response = await app.inject({ method: 'POST', url: `/v1/plugins/data/${operation}`,
                headers: { 'x-test-user-id': 'account-1',
                    'x-happier-account-stored-content-protocol': String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION) },
                payload: { pluginId: 'example.tasks', collectionId: 'tasks',
                    writerContext: { schemaVersion: 1, contractDigest: 'a'.repeat(43) },
                    ...(operation === 'mutate'
                        ? { operations: [{ kind: 'delete', rowId: 'task-1', expectedRevision: 1 }] }
                        : { rowId: 'task-1', expectedRevision: 1 }),
                },
            });
            expect(response.statusCode).toBe(503);
            expect(readHomeDomainConfirmedRollbackV1(response.statusCode, response.json())).toEqual({
                code: 'database_transaction_conflict_exhausted',
                details: { error: 'database_transaction_conflict_exhausted', statusCode: 503 },
            });
            expect(response.body).not.toContain('private');
        } finally { await app.close(); }
    });

    it.each(['P2034', 'P2028'])('does not classify an unqualified %s driver failure as rollback or acquisition exhaustion', async code => {
        const app = Fastify({ logger: false });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.post('/unclassified-write', async () => { throw Object.assign(new Error('unknown outcome'), { code }); });
        try {
            const response = await app.inject({ method: 'POST', url: '/unclassified-write' });
            expect(response.statusCode).toBe(500);
            expect(response.json().error).toBe('Internal Server Error');
        } finally {
            await app.close();
        }
    });

    it('projects transaction acquisition exhaustion on a managed list read as typed unavailable', async () => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        transaction.mockRejectedValue(Object.assign(new Error('private acquisition detail'), {
            code: 'P2028', meta: { error: 'Unable to start a transaction in the given time.' },
        }));
        const app = Fastify({ logger: false });
        enableErrorHandlers(app as Parameters<typeof enableErrorHandlers>[0]);
        app.post('/v1/machines/managed/actions/list', async () => inTx(async () => ({ machines: [] })));
        try {
            const response = await app.inject({ method: 'POST', url: '/v1/machines/managed/actions/list' });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'database_connection_unavailable', statusCode: 503 });
            expect(response.body).not.toContain('private');
        } finally {
            await app.close();
        }
    });
});
