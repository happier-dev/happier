import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { expect } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { exerciseManagedSessionBirth } from './sessionManagedBirth.testkit';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('managed birth PostgreSQL contract', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await db.$disconnect(); vi.unstubAllEnvs(); });
    it('commits and selects unique managed birth without opening 1,000 unrelated Sessions', () => exerciseManagedSessionBirth({
        measureLookup: async read => {
            const original = db.$transaction;
            // Observe engine-emitted SQL at the real DB transport, retaining real route/transaction logic.
            db.$transaction = new Proxy(original, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            try {
                statements.length = 0;
                await read();
                const sessionReads = statements.filter(({ query }) => /^SELECT\b/.test(query)
                    && /FROM "public"\."Session"(?:\s|$)/.test(query));
                let selectedRows = 0;
                let hydratedBodies = 0;
                for (const { query, params } of sessionReads) {
                    const values: unknown[] = JSON.parse(params);
                    const rows = await db.$queryRawUnsafe<unknown[]>(query, ...values);
                    selectedRows += rows.length;
                    if (/"(?:metadata|ownerMetadata|agentState)"/.test(query)) hydratedBodies += rows.length;
                }
                expect(selectedRows).toBe(1);
                expect(hydratedBodies).toBe(0);
                console.info('MANAGED_BIRTH_SQL_WORK', { unrelatedSessions: 1_000, selectedRows, hydratedBodies });
            } finally { db.$transaction = original; }
        },
    }));
});
