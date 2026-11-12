import { afterAll, beforeAll, describe } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { defineTeamCredentialUsageCounterContract } from './teamCredentialUsageCounters.testkit';
describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Team spend counters (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });
    defineTeamCredentialUsageCounterContract({ concurrent: true });
});
