import { prepareDisposableTestDatabase } from './disposableTestDatabase.mjs';

/** Reset only the current worker's database inside an explicitly supplied test
 * container. setupFiles runs for every file: serial files also retain rows unless
 * the worker database is refreshed from the unchanged migrated template. */
export function prepareDbContractDatabase() {
  const containerId = process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID;
  if (!containerId) return;
  const poolId = process.env.VITEST_POOL_ID;
  const db = process.env.HAPPIER_DB_PROVIDER;
  if (!/^[a-f0-9]{64}$/.test(containerId) || !poolId || !/^\d+$/.test(poolId)
    || (db !== 'postgres' && db !== 'mysql')) {
    throw new Error('DB contract isolation requires an exact test container, provider and Vitest pool id');
  }
  const databaseUrl = prepareDisposableTestDatabase({ databaseName: `happier_contract_${poolId}`,
    dbProvider: db, sourceDatabaseUrl: process.env.HAPPIER_DB_CONTRACT_TEMPLATE_URL });
  process.env.DATABASE_URL = databaseUrl;
  process.env[db === 'postgres' ? 'HAPPIER_TEST_POSTGRES_DATABASE_URL' : 'HAPPIER_TEST_MYSQL_DATABASE_URL'] = databaseUrl;
}

prepareDbContractDatabase();
