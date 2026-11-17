import { afterAll, beforeAll, describe } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { defineResourceUsagePerformanceContract } from './resourceUsage.performance.testkit';
import { createDbMaintenanceClient, onDbClientQuery } from '@/storage/prisma';

async function createQueryClient() {
    return await createDbMaintenanceClient('sqlite', undefined, { log: [{ emit: 'event', level: 'query' }] });
}

describe('Team usage page cost (SQLite)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let harness: LightSqliteHarness;
    let client: Awaited<ReturnType<typeof createQueryClient>>;
    let originalTransaction: typeof db.$transaction;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'teamperf-usage-' });
        client = await createQueryClient();
        onDbClientQuery(client, event => queries.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        const traced = client;
        // Instrument only persistent transport; query, authority and reconciliation owners remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
    }, 120_000);
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await harness?.close();
    });
    defineResourceUsagePerformanceContract({ provider: 'sqlite', queries });
});
