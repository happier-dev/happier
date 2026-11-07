import { afterAll, beforeAll, describe } from 'vitest';
import { auth } from '@/app/auth/auth';
import { initEncrypt } from '@/modules/encrypt';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerWorkflowChildAuthorizationCharacterization } from './workflowChildAuthorization.composed.testkit';

describe('real Workflow reviewed-child PostgreSQL composition', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>> | undefined;
    beforeAll(async () => {
        if (process.env.HAPPIER_DB_PROVIDER !== 'postgres'
            || !process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use only the disposable PostgreSQL DB-contract harness');
        }
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-workflow-reviewed-child-', env: {
            HANDY_MASTER_SECRET: crypto.randomUUID(), AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        } });
        await auth.init();
        await initEncrypt();
    });
    afterAll(async () => { await harness?.close(); });

    registerWorkflowChildAuthorizationCharacterization();
});
