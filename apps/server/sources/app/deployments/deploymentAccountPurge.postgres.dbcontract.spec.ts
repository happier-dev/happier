import { afterAll, beforeAll, describe } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { deploymentAccountPurgeCases } from './deploymentAccountPurge.testkit';

describe('Account deployment purge (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    deploymentAccountPurgeCases();
});
