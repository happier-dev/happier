import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import * as serverRuntime from '@happier-dev/cli-common/firstPartyRuntime/server';
import { assertCanonicalManagedStackName } from '../stack/names.mjs';
import { resolveSharedDatabaseSource } from './effective_db_provider.mjs';
import { runServerDatabaseTask } from './server_database_task.mjs';

export class SharedDatabaseMigrationError extends Error {
  constructor({ code, sourceStack, missingMigrations = [] }) {
    const missing = code === 'ESHAREDDBMIGRATIONSMISSING';
    super(missing
      ? `[shared-db] ${code}: refusing server start; source stack "${sourceStack}" is missing required migrations: ${missingMigrations.join(', ')}. `
        + `The source stack owner must deploy them (for example, restart source stack "${sourceStack}"), `
        + 'or the migration author must reconcile its retained database per AGENTS.md Compatibility. Shared-DB consumers never migrate the source database.'
      : `[shared-db] ${code}: refusing server start; migration readiness for source stack "${sourceStack}" is unavailable. `
        + 'Check source database access and the consumer server migration catalog, then retry. Shared-DB consumers never migrate the source database.');
    this.name = 'SharedDatabaseMigrationError';
    this.code = code;
    this.phase = 'server_start';
    this.retryable = !missing;
    this.sourceStack = sourceStack;
    this.missingMigrations = missingMigrations;
  }
}

async function readSourceLedger({ databaseOwnerDir, env, provider }) {
  if (provider === 'sqlite') {
    const { databasePath } = serverRuntime.resolvePersonalHomeRuntimeLayout({ env });
    return await serverRuntime.readSqlitePrismaMigrationLedger(databasePath);
  }
  return await runServerDatabaseTask({ serverDir: databaseOwnerDir, provider, task: 'migration-ledger', databaseUrl: env.DATABASE_URL,
    env: { ...process.env, ...env } });
}

/** Called on the server host after canonical shared-source environment projection.
 * One read-only ledger SELECT per launch; no migration, repair, cache or poll.
 * `serverDir` supplies the required migration catalog (the payload being launched);
 * `databaseOwnerDir` is the server source checkout that opens a Postgres ledger. A runtime
 * payload carries no database owner, so runtime launches pass their source checkout. */
export async function assertSharedDatabaseMigrationsApplied({ serverDir, databaseOwnerDir = serverDir, env = {} }) {
  const configuredSource = String(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK ?? '').trim();
  if (!configuredSource) return;
  let sourceStack = '<configured source>';
  let provider;
  let expectedMigrations;
  let rows;
  try {
    assertCanonicalManagedStackName(configuredSource, 'shared database source');
    sourceStack = configuredSource;
    ({ provider } = resolveSharedDatabaseSource({ env }));
    const catalogDir = join(serverDir, 'prisma', ...(provider === 'sqlite' ? ['sqlite'] : []), 'migrations');
    expectedMigrations = (await readdir(catalogDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    if (expectedMigrations.length === 0 || expectedMigrations.some(name => !/^\d{14}_[a-z0-9_]+$/.test(name))) {
      throw new Error('Invalid migration catalog');
    }
    for (const name of expectedMigrations) {
      if (!(await stat(join(catalogDir, name, 'migration.sql'))).isFile()) throw new Error('Missing migration SQL');
    }
    rows = await readSourceLedger({ databaseOwnerDir, env, provider });
  } catch {
    // Driver/configuration errors can contain connection values. Never retain or print them.
    throw new SharedDatabaseMigrationError({ code: 'ESHAREDDBMIGRATIONSTATUSUNAVAILABLE', sourceStack });
  }
  const applied = new Set(rows.filter(row => row.finished_at != null && row.rolled_back_at == null)
    .map(row => row.migration_name));
  const missingMigrations = expectedMigrations.filter(name => !applied.has(name));
  if (missingMigrations.length > 0) {
    throw new SharedDatabaseMigrationError({ code: 'ESHAREDDBMIGRATIONSMISSING', sourceStack, missingMigrations });
  }
  return { provider, sourceStack, expectedMigrations, missingMigrations };
}
