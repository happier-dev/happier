import { db, initDbMysql, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { applyEnvValues, restoreEnv, snapshotEnv } from './env';
import { createLightSqliteHarness, type LightSqliteHarness, type LightSqliteHarnessOptions } from './lightSqliteHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLightDefaultEnv, ensureHandyMasterSecret } from '@/flavors/light/env';
import { initEncrypt } from '@/modules/encrypt';

/** Existing integration suites can also consume the canonical disposable provider
 * contract runner. Outside that exact runner their SQLite lifecycle is unchanged. */
export async function createDatabaseIntegrationHarness(options: Pick<LightSqliteHarnessOptions, 'tempDirPrefix' | 'initAuth' | 'initEncrypt' | 'env'>): Promise<
    Pick<LightSqliteHarness, 'baseDir' | 'resetEnv' | 'resetDbTables' | 'close'>
> {
    const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
    const provider = process.env.HAPPIER_DB_PROVIDER;
    if ((provider !== 'postgres' && provider !== 'mysql') || !containerId) {
        return await createLightSqliteHarness(options);
    }
    const isolatedDatabaseUrl = process.env[provider === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'];
    if (!/^[a-f0-9]{64}$/.test(containerId) || !/^\d+$/.test(process.env.VITEST_POOL_ID ?? '')
        || !isolatedDatabaseUrl || process.env.DATABASE_URL !== isolatedDatabaseUrl) {
        throw new Error('Provider integration requires the disposable DB-contract runner');
    }
    const envBase = snapshotEnv();
    const baseDir = await mkdtemp(join(tmpdir(), options.tempDirPrefix));
    try {
        applyEnvValues({ HAPPIER_SERVER_LIGHT_DATA_DIR: baseDir, HAPPY_SERVER_LIGHT_DATA_DIR: baseDir, ...options.env });
        applyLightDefaultEnv(process.env);
        await ensureHandyMasterSecret(process.env);
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        if (options.initAuth) {
            const { auth } = await import('@/app/auth/auth');
            await auth.init();
        }
        if (options.initEncrypt) await initEncrypt();
    } catch (error) {
        await shutdownDbClient();
        restoreEnv(envBase);
        await rm(baseDir, { recursive: true, force: true });
        throw error;
    }
    const configuredEnv = snapshotEnv();
    return {
        baseDir,
        resetEnv: (overrides = {}) => {
            restoreEnv(configuredEnv);
            applyEnvValues(overrides);
            return snapshotEnv();
        },
        resetDbTables: async operations => { for (const operation of operations) await operation(); },
        close: async () => {
            try { await shutdownDbClient(); }
            finally { restoreEnv(envBase); await rm(baseDir, { recursive: true, force: true }); }
        },
    };
}
