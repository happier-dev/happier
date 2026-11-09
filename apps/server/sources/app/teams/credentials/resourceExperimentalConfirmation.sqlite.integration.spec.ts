import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerTeamCredentialResourceRoutes } from './registerTeamCredentialResourceRoutes';

describe('retired Team experimental confirmation (real SQLite/HTTP)', () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'resource-experimental-confirmation-', initAuth: false,
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_TEAMS_CREDENTIAL_RESOURCES__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        app = createAuthenticatedTestApp();
        registerTeamCredentialResourceRoutes(app);
        await app.ready();
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    it('does not expose the retired Team confirmation writer', async () => {
        const response = await app.inject({ method: 'POST', url: '/v1/teams/credential-resources/experimental-confirmation',
            headers: { 'x-test-user-id': 'synthetic-account' }, payload: {} });
        expect(response.statusCode).toBe(404);
    });

});
