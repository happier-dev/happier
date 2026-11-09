import { afterAll, beforeAll, describe, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbMysql, shutdownDbClient } from '@/storage/db';
import { verifySessionQueryEquivalence } from './queryEquivalence.test-support';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'mysql')('Session query membership and keysets (MySQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_MYSQL_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_MYSQL_DATABASE_URL) {
            throw new Error('Use the disposable MySQL DB-contract harness');
        }
        initDbMysql();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });
    it('matches the monolithic relation across relevance, publication branches and attention', verifySessionQueryEquivalence);
});
