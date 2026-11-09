import { afterAll, beforeAll, describe, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { discussionSecondOpinionSecurityContracts } from './secondOpinionSecurity.testkit';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Second opinion source security (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'second-opinion-disposable-fixture');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS__ENABLED', '1');
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED', '1');
        initDbPostgres();
        await db.$connect();
        await initEncrypt();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });
    discussionSecondOpinionSecurityContracts();
});
