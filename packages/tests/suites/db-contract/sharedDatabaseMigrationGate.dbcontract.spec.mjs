import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import { assertSharedDatabaseMigrationsApplied } from '../../../../apps/stack/scripts/utils/server/shared_database_migration_gate.mjs';
import { preflightSourceRuntimeMigrations } from '../../../../apps/stack/scripts/runtime/launch/preflightSourceRuntimeMigrations.mjs';
import { runNodeCapture } from '../../../../apps/stack/scripts/testkit/core/run_node_capture.mjs';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const canonicalServer = join(repoDir, 'apps/server');
const requireServer = createRequire(join(canonicalServer, 'package.json'));

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('shared DB launch admission on ephemeral PostgreSQL', () => {
  it('executes the source reload and required startup provider-agreement journey against the real ledger', async () => {
    assert.ok(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID, 'requires the ephemeral Docker contract runner');
    const result = await runNodeCapture(['--test', '--test-reporter=tap',
      '--test-name-pattern=^source reload and required startup reuse agree on a shared Postgres provider$',
      'apps/stack/scripts/build/build_source_runtime.test.mjs'], { cwd: repoDir, env: process.env });
    if (result.code !== 0) {
      const diagnostic = `${result.stdout}\n${result.stderr}`.split(/\r?\n/)
        .filter(line => !/\:\/\/|bearer |token|secret|password|api_?key|credential|database_url|-----begin|private_key|[A-Za-z0-9+/_=-]{40,}\.[A-Za-z0-9+/_=-]{20,}/i.test(line)).join('\n');
      assert.fail(`Provider-agreement source journey failed (${result.code}):\n${diagnostic}`);
    }
    const executed = /^ok \d+ - source reload and required startup reuse agree on a shared Postgres provider\r?$/m.test(result.stdout);
    assert.equal(executed, true, 'the exact native provider-agreement case must execute without a skip');
    // The native journey owns its build-admission lifecycle; this bridge must
    // not cut that operation off at the DB suite's unrelated default timeout.
  }, 0);

  it('admits equal/source-ahead, refuses consumer-ahead, and fails closed for absent/empty ledgers', async () => {
    assert.ok(process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID, 'requires the ephemeral Docker contract runner');
    const scratch = await mkdtemp(join(tmpdir(), 'hstack-shared-db-postgres-'));
    let client;
    try {
      const serverDir = join(scratch, 'server');
      const migrations = join(serverDir, 'prisma/migrations');
      await mkdir(migrations, { recursive: true });
      await writeFile(join(serverDir, 'package.json'), '{}');
      // Resolve from the real server: pnpm may hoist this package above its
      // node_modules directory, outside the temporary consumer's ancestor chain.
      await mkdir(join(serverDir, 'node_modules/@prisma'), { recursive: true });
      await symlink(dirname(requireServer.resolve('@prisma/client/package.json')),
        join(serverDir, 'node_modules/@prisma/client'), process.platform === 'win32' ? 'junction' : 'dir');
      const expected = (await readdir(join(canonicalServer, 'prisma/migrations'), { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
      assert.ok(expected.length > 1);
      const env = { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'db-contract-source', HAPPIER_DB_PROVIDER: 'postgres',
        DATABASE_URL: process.env.DATABASE_URL };
      const add = async name => {
        await mkdir(join(migrations, name));
        await writeFile(join(migrations, name, 'migration.sql'), 'SELECT 1;\n');
      };
      const sourceEnvPath = join(scratch, 'source.env');
      await writeFile(sourceEnvPath, `HAPPIER_DB_PROVIDER=postgres\nHAPPIER_FILES_BACKEND=s3\nDATABASE_URL=${env.DATABASE_URL}\nHANDY_MASTER_SECRET=${randomUUID()}\n`);
      const preflight = () => preflightSourceRuntimeMigrations({
        server: { serverDir, serverComponent: 'happier-server-light', dbProvider: 'postgres',
          migration: { mode: 'external', command: 'shared-consumer-must-never-deploy' } },
        env: { ...env, HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: sourceEnvPath }, stackBaseDir: scratch,
      });
      await add(expected[0]);
      assert.deepEqual((await assertSharedDatabaseMigrationsApplied({ serverDir, env })).missingMigrations, []);
      for (const name of expected.slice(1)) await add(name);
      assert.deepEqual((await assertSharedDatabaseMigrationsApplied({ serverDir, env })).missingMigrations, []);
      await preflight();
      const missing = '29990101000000_not_deployed';
      await add(missing);
      await assert.rejects(preflight(), error => error.code === 'ESHAREDDBMIGRATIONSMISSING'
        && error.sourceStack === 'db-contract-source'
        && JSON.stringify(error.missingMigrations) === JSON.stringify([missing]));
      await assert.rejects(assertSharedDatabaseMigrationsApplied({ serverDir, env }), error =>
        error.code === 'ESHAREDDBMIGRATIONSMISSING' && error.sourceStack === 'db-contract-source'
          && JSON.stringify(error.missingMigrations) === JSON.stringify([missing])
          && !error.message.includes(env.DATABASE_URL));

      // Only the runner-owned ephemeral worker DB is mutated. A separate empty
      // schema represents a fresh source without touching its migrated ledger.
      const { Client } = requireServer('pg');
      client = new Client({ connectionString: env.DATABASE_URL });
      await client.connect();
      await client.query('CREATE SCHEMA shared_db_gate_fresh');
      const freshUrl = new URL(env.DATABASE_URL);
      freshUrl.searchParams.set('schema', 'shared_db_gate_fresh');
      const freshEnv = { ...env, DATABASE_URL: freshUrl.href };
      await assert.rejects(assertSharedDatabaseMigrationsApplied({ serverDir, env: freshEnv }), error =>
        error.code === 'ESHAREDDBMIGRATIONSTATUSUNAVAILABLE' && error.cause === undefined
          && !error.message.includes(freshEnv.DATABASE_URL));
      await client.query('CREATE TABLE shared_db_gate_fresh._prisma_migrations '
        + '(migration_name TEXT, checksum TEXT, finished_at TIMESTAMP, rolled_back_at TIMESTAMP)');
      await assert.rejects(assertSharedDatabaseMigrationsApplied({ serverDir, env: freshEnv }), error =>
        error.code === 'ESHAREDDBMIGRATIONSMISSING'
          && JSON.stringify(error.missingMigrations) === JSON.stringify([...expected, missing])
          && !error.message.includes(freshEnv.DATABASE_URL));
    } finally {
      if (client) {
        try { await client.query('DROP SCHEMA IF EXISTS shared_db_gate_fresh CASCADE'); }
        finally { await client.end(); }
      }
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
