import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDbModuleMock } from '../../testkit/dbMocks';

const accountFindUnique = vi.fn();
// Substitute the persistent connection, retaining real Account reads and HTTP error projection.
installDbModuleMock({ db: { account: { findUnique: accountFindUnique } } });

const { createAuthenticatedTestApp } = await import('../../testkit/sqliteFastify');
const { registerAccountEncryptionRoutes } = await import('./registerAccountEncryptionRoutes');

describe('Account encryption storage unavailability', () => {
    beforeEach(() => {
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres');
        // Route projection is under test; transaction retry timing has its own owner suite.
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
    });

    afterEach(() => {
        accountFindUnique.mockReset();
        vi.unstubAllEnvs();
    });

    it.each([
        { url: '/v1/account/encryption', storageCode: 'P2024', error: 'database_connection_unavailable' },
        { url: '/v1/account/encryption/currentness', storageCode: 'P2024', error: 'database_connection_unavailable' },
    ])(
        'projects $storageCode through $url as the global typed 503', async ({ url, storageCode, error }) => {
            accountFindUnique.mockRejectedValue(Object.assign(new Error('private database details'), { code: storageCode }));
            const app = createAuthenticatedTestApp();
            registerAccountEncryptionRoutes(app);
            try {
                const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': 'account-1' } });
                expect(response.statusCode).toBe(503);
                expect(response.json()).toEqual({ error, statusCode: 503 });
                expect(response.body).not.toContain('private');
                expect(response.body).not.toContain('P2024');
            } finally {
                await app.close();
            }
        },
    );
});
