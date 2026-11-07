import { afterAll, beforeAll, describe } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { defineResourceUsagePerformanceContract } from './resourceUsage.performance.testkit';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Team usage page cost (PostgreSQL)', () => {
    const queries: Prisma.QueryEvent[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    let originalTransaction: typeof db.$transaction;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => queries.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        const traced = client;
        // Instrument only persistent transport; query, authority and reconciliation owners remain real.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await shutdownDbClient();
    });
    defineResourceUsagePerformanceContract({ provider: 'postgres', queries });
});
