import { afterAll, beforeAll } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { approvalIdentityContract } from './approvalIdentity.contract.testkit';

let connected = false;
beforeAll(async () => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Run with the disposable PostgreSQL DB-contract harness');
    }
    process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = 'none';
    initDbPostgres();
    await db.$connect();
    connected = true;
});
afterAll(async () => { if (connected) await db.$disconnect(); });
approvalIdentityContract();
