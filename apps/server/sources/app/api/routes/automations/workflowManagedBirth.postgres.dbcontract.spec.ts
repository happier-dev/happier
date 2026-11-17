import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { exerciseManagedWorkflowBirth } from './workflowManagedBirth.testkit';
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('managed Run birth PostgreSQL contract', () => {
    const statements: Prisma.QueryEvent[] = [];
    let client: PrismaClientType;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await db.$disconnect(); vi.unstubAllEnvs(); });
    it('selects one id and zero private bodies with 1,000 unrelated Runs and Sessions', () => exerciseManagedWorkflowBirth({
        measureLookup: async read => {
            const original = db.$transaction;
            db.$transaction = new Proxy(original, { apply(_target, _receiver, args) {
                return Reflect.apply(client.$transaction, client, args);
            } });
            try {
                statements.length = 0;
                await read();
                const reads = statements.filter(({ query }) => /^SELECT\b/.test(query) && /FROM "public"\."(?:Session|AutomationRun)"(?:\s|$)/.test(query));
                let selectedRows = 0;
                for (const { query, params } of reads) {
                    const values: unknown[] = JSON.parse(params);
                    selectedRows += (await db.$queryRawUnsafe<unknown[]>(query, ...values)).length;
                    expect(query).not.toMatch(/"(?:metadata|ownerMetadata|agentState|workflowAcceptedSnapshotEnvelope|executionInputEnvelope|workflowCheckpointEnvelope)"/);
                    expect(query).not.toMatch(/FROM "public"\."Session"/);
                }
                expect(selectedRows).toBe(1);
                console.info('MANAGED_RUN_BIRTH_SQL_WORK', { unrelatedSessions: 1_000, unrelatedRuns: 1_000, selectedRows, hydratedBodies: 0 });
            } finally { db.$transaction = original; }
        },
    }));
});
