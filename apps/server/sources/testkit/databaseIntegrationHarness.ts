import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { applyEnvValues, restoreEnv, snapshotEnv } from './env';
import { createLightSqliteHarness, type LightSqliteHarness, type LightSqliteHarnessOptions } from './lightSqliteHarness';

/** Existing integration suites can also consume the canonical disposable provider
 * contract runner. Outside that exact runner their SQLite lifecycle is unchanged. */
export async function createDatabaseIntegrationHarness(options: Pick<LightSqliteHarnessOptions, 'tempDirPrefix' | 'initAuth' | 'env'>): Promise<
    Pick<LightSqliteHarness, 'resetEnv' | 'resetDbTables' | 'close'>
> {
    const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
    const provider = process.env.HAPPIER_DB_PROVIDER;
    if ((provider !== 'postgres' && provider !== 'mysql') || !containerId) {
        return await createLightSqliteHarness(options);
    }
    if (!/^[a-f0-9]{64}$/.test(containerId) || !/^\d+$/.test(process.env.VITEST_POOL_ID ?? '')) {
        throw new Error('Provider integration requires the disposable DB-contract runner');
    }
    if (provider === 'mysql') await initDbMysql();
    else initDbPostgres();
    await db.$connect();
    const envBase = snapshotEnv();
    applyEnvValues(options.env ?? {});
    return {
        resetEnv: (overrides = {}) => {
            restoreEnv(envBase);
            applyEnvValues({ ...options.env, ...overrides });
            return snapshotEnv();
        },
        resetDbTables: async operations => { for (const operation of operations) await operation(); },
        close: async () => { await db.$disconnect(); if (options.env) restoreEnv(envBase); },
    };
}
