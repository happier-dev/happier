import { afterAll, beforeAll, describe } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { workflowDiscussionRoundPersistenceContracts } from './workflowDiscussionRound.testkit';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Workflow Discussion round writes (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        await getOrCreateServerIdentityId();
    });
    afterAll(async () => { await db.$disconnect(); });
    workflowDiscussionRoundPersistenceContracts();
});
