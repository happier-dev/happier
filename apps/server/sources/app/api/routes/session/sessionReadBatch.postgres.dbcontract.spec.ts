import { afterAll, beforeAll, describe, vi } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { sessionReadBatchCostContract } from './sessionReadBatchCost.testkit';
describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session read-batch cost (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract Docker runner');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });
    sessionReadBatchCostContract('postgres');
});
