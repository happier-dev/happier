import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySqliteMigrations,
  applySqliteMigrationsFromEnvironment,
  type SqliteMigrationExecutor,
} from '../sources/flavors/light/sqliteMigrations';

const root = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-bun-runtime-'));
const migrationsDir = join(root, 'migrations');
const migrationName = '20260101000000_partial';
const migrationDir = join(migrationsDir, migrationName);
const dbPath = join(root, 'happier.sqlite');

try {
  await mkdir(migrationDir, { recursive: true });
  await writeFile(
    join(migrationDir, 'migration.sql'),
    'CREATE TABLE Account(id INTEGER);\nCREATE TABLE Widget(id INTEGER);\n',
    'utf8',
  );

  const db = new Database(dbPath);
  db.exec('CREATE TABLE Account(id INTEGER);');
  const executor: SqliteMigrationExecutor = {
    exec: (sql) => {
      db.exec(sql);
    },
    queryTableNames: () => {
      const rows = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all();
      return new Set(rows.map((row) => String(row.name)));
    },
    queryAppliedMigrations: () => {
      const rows = db.query(
        `SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`,
      ).all();
      return rows.map((row) => ({
        name: String(row.migration_name),
        checksum: String(row.checksum),
      }));
    },
    insertAppliedMigration: ({ name, checksum }) => {
      db.query(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
      ).run(randomUUID(), checksum, name);
    },
  };

  let rejection: unknown;
  try {
    await applySqliteMigrations({ executor, migrationsDir });
  } catch (error) {
    rejection = error;
  }

  if (rejection == null || !String((rejection as Error).message ?? rejection).includes('cannot be marked applied safely')) {
    throw new Error(`Expected unsafe partial migration rejection, received: ${String(rejection ?? '<success>')}`);
  }

  try {
    const widget = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='Widget'`).get();
    if (widget != null) {
      throw new Error('Unsafe partial migration left Widget behind');
    }
    const ledger = db.query(
      'SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?',
    ).get(migrationName);
    if (ledger != null) {
      throw new Error('Unsafe partial migration wrote a finished ledger row');
    }
  } finally {
    db.close();
  }

  const adapterMigrationsDir = join(root, 'adapter-migrations');
  const adapterMigrationName = '20260101000001_adapter';
  await mkdir(join(adapterMigrationsDir, adapterMigrationName), { recursive: true });
  await writeFile(
    join(adapterMigrationsDir, adapterMigrationName, 'migration.sql'),
    'CREATE TABLE BunAdapterProof(id INTEGER PRIMARY KEY);\n',
    'utf8',
  );
  const adapterDbPath = join(root, 'adapter.sqlite');
  await applySqliteMigrationsFromEnvironment({
    env: {
      DATABASE_URL: `file:${adapterDbPath}`,
      HAPPIER_SQLITE_MIGRATIONS_DIR: adapterMigrationsDir,
    },
    dataDir: root,
  });
  const adapterDb = new Database(adapterDbPath);
  try {
    const table = adapterDb.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='BunAdapterProof'`,
    ).get();
    if (table == null) {
      throw new Error('Canonical Bun SQLite adapter did not apply its migration');
    }
  } finally {
    adapterDb.close();
  }

  const activationMigrationName =
    '20260725100000_activate_qualified_connected_accounts_v4';
  const sourceMigrationsDir = join(
    import.meta.dirname,
    '..',
    'prisma',
    'sqlite',
    'migrations',
  );
  const qualifiedMigrationsDir = join(root, 'qualified-migrations');
  await mkdir(qualifiedMigrationsDir, { recursive: true });
  const sourceMigrationEntries = await readdir(sourceMigrationsDir, {
    withFileTypes: true,
  });
  for (const entry of sourceMigrationEntries) {
    if (!entry.isDirectory() || entry.name >= activationMigrationName) continue;
    await cp(
      join(sourceMigrationsDir, entry.name),
      join(qualifiedMigrationsDir, entry.name),
      { recursive: true },
    );
  }

  const qualifiedDbPath = join(root, 'qualified.sqlite');
  const qualifiedEnv = {
    DATABASE_URL: `file:${qualifiedDbPath}`,
    HAPPIER_SQLITE_MIGRATIONS_DIR: qualifiedMigrationsDir,
  };
  await applySqliteMigrationsFromEnvironment({
    env: qualifiedEnv,
    dataDir: root,
  });
  const qualifiedDb = new Database(qualifiedDbPath);
  try {
    qualifiedDb.exec(`
      INSERT INTO "Account" ("id", "updatedAt")
      VALUES ('account-1', CURRENT_TIMESTAMP);
      INSERT INTO "ServiceAccountToken" (
        "id", "accountId", "vendor", "profileId", "token", "metadata", "updatedAt"
      ) VALUES (
        'credential-1', 'account-1', 'openai-codex', 'profile-1',
        X'03', json('{"v":2,"kind":"oauth"}'), CURRENT_TIMESTAMP
      );
    `);
  } finally {
    qualifiedDb.close();
  }
  await cp(
    join(sourceMigrationsDir, activationMigrationName),
    join(qualifiedMigrationsDir, activationMigrationName),
    { recursive: true },
  );
  await applySqliteMigrationsFromEnvironment({
    env: qualifiedEnv,
    dataDir: root,
  });
  const activatedDb = new Database(qualifiedDbPath);
  try {
    const credential = activatedDb.query(`
      SELECT
        "service_plugin_id" AS "servicePluginId",
        "service_local_id" AS "serviceLocalId",
        "connected_account_id" AS "connectedAccountId",
        "authentication_mode_id" AS "authenticationModeId"
      FROM "ServiceAccountToken"
      WHERE "id" = 'credential-1'
    `).get();
    if (
      credential?.servicePluginId !== 'happier.agent.codex'
      || credential?.serviceLocalId !== 'openai-codex'
      || credential?.connectedAccountId !== 'profile-1'
      || credential?.authenticationModeId !== 'oauth'
    ) {
      throw new Error(
        `Canonical Bun SQLite adapter did not prepare qualified Connected Accounts: ${JSON.stringify(credential)}`,
      );
    }
  } finally {
    activatedDb.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
