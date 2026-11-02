import { afterAll, beforeAll, describe, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { exerciseManagedPresetAcquireCost } from './managedProjectionVolume.testkit';

describe('managed preset Create cost on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    it('keeps preset Create reads independent of historical allocations', exerciseManagedPresetAcquireCost, 120_000);
});
