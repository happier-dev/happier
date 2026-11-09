import { afterAll, beforeAll, describe, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { workflowReplyCustodyContract } from './sessionMessageReplyWorkflowCustody.testkit';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('retained Workflow reply custody (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'workflow-reply-custody-test-secret');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres(); await db.$connect(); await auth.init();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });
    workflowReplyCustodyContract();
});
