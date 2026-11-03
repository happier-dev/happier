import { verifySessionSpaceMembershipListing } from './spaceMembership.test-support';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Space membership before Session pagination (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { vi.unstubAllEnvs(); await shutdownDbClient(); });

    it('unions the saved lens with viewer-owned explicit tags before paging, then applies fixed audience and refinements', verifySessionSpaceMembershipListing);
});
