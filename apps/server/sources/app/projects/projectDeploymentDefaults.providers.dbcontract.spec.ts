import { afterAll, beforeAll, describe, it } from 'vitest';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { exerciseProjectDefaultsStorage } from './projectDeploymentDefaults.testkit';

const provider = getDbProviderFromEnv(process.env, 'postgres');
describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('Project defaults native provider persistence', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let connected = false;
    const identity = process.env.HAPPIER_SERVER_IDENTITY_ID;
    beforeAll(async () => {
        const target = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!target || process.env.DATABASE_URL !== target) throw new Error('Run with the disposable native DB-contract harness');
        process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        if (identity === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = identity;
    });
    it.each(['plain', 'e2ee'] as const)('retains Source admission, %s mode, recipient keys, FKs and independent CAS', async mode => {
        await exerciseProjectDefaultsStorage(mode, serverId);
    });
});
