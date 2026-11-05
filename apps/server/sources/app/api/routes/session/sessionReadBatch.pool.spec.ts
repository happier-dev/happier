import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionReadBatchRoute } from './registerSessionReadBatchRoute';
import { initDbPostgres, shutdownDbClient } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';

const pool = vi.hoisted(() => ({ limit: 1, active: 0, peak: 0, failSessionId: '' }));
vi.mock('@/storage/db', async () => ({
    ...await vi.importActual<typeof import('@/storage/db')>('@/storage/db'),
    db: { $transaction: async <T>(read: (tx: Tx) => Promise<T>) => {
        if (pool.active >= pool.limit) throw Object.assign(new Error('Pool acquisition timeout'), { code: 'P2024' });
        pool.active += 1;
        pool.peak = Math.max(pool.peak, pool.active);
        // Genuine Prisma transaction/pool boundary; route, admission and inTx stay real.
        const tx = { ...inTxPostgresControlStatementMock,
            // C1FIX captures the Account observation cut even for an empty id result.
            account: { findUniqueOrThrow: async () => ({ seq: 0 }) },
            session: { findMany: async (input: Readonly<{ where: { id: { in: readonly string[] } } }>) => {
                await setImmediate();
                if (pool.failSessionId && input.where.id.in.includes(pool.failSessionId)) {
                    throw Object.assign(new Error('Database unavailable for this chunk'), { code: 'P2024' });
                }
                return [];
            } },
        } as unknown as Tx;
        try { return await read(tx); } finally { pool.active -= 1; }
    } },
}));

describe('Session batch database pool admission', () => {
    afterEach(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });

    it.each([
        { limit: 2, urlLimit: 2, override: undefined, failFirstChunk: false },
        { limit: 3, urlLimit: 1, override: '3', failFirstChunk: false },
        { limit: 2, urlLimit: 2, override: undefined, failFirstChunk: true },
    ])('keeps every per-id outcome within the $limit-connection pool (failed chunk: $failFirstChunk)', async ({ limit, urlLimit, override, failFirstChunk }) => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        vi.stubEnv('DATABASE_URL', `postgresql://fixture:fixture@localhost/fixture?connection_limit=${urlLimit}`);
        vi.stubEnv('HAPPIER_DB_CONNECTION_LIMIT', override ?? '');
        vi.stubEnv('HAPPY_DB_CONNECTION_LIMIT', '');
        initDbPostgres();
        // Configuration edits take effect at the next database initialization,
        // not midway through serving batches from the existing pool.
        vi.stubEnv('HAPPIER_DB_CONNECTION_LIMIT', '1');
        Object.assign(pool, { limit, active: 0, peak: 0, failSessionId: failFirstChunk ? 'missing-0' : '' });
        const sessionIds = Array.from({ length: failFirstChunk ? 201 : limit * 4 + 1 }, (_, index) => `missing-${index}`);
        await withAuthenticatedTestApp(registerSessionReadBatchRoute, async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/sessions/read-batch',
                headers: { 'x-test-user-id': 'owner', 'x-happier-account-stored-content-protocol': '4' },
                payload: { sessionIds, accessProjectionVersion: 1 } });
            expect(response.statusCode).toBe(200);
            const { results } = SessionReadBatchResponseV1Schema.parse(response.json());
            expect(results.map(result => result.sessionId)).toEqual(sessionIds);
            expect(results.map(result => result.detail?.status)).toEqual(sessionIds.map((_id, index) => failFirstChunk && index < 200 ? 503 : 404));
            expect(pool.peak).toBeGreaterThan(0);
            expect(pool.peak).toBeLessThanOrEqual(limit - 1);
            expect(pool.active).toBe(0);
        });
    });
});
