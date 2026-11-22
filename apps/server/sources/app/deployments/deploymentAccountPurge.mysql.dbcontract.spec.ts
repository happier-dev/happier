import { afterAll, beforeAll, describe } from 'vitest';
import { db, initDbMysql } from '@/storage/db';
import { deploymentAccountPurgeCases } from './deploymentAccountPurge.testkit';

describe('Account deployment purge (MySQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID || !process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_MYSQL_DATABASE_URL) {
            throw new Error('Requires disposable MySQL DB-contract harness');
        }
        initDbMysql();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    deploymentAccountPurgeCases();
});
