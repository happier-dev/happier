import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySqliteMigrations,
  applySqliteMigrationsFromEnvironment,
  applySqliteMigrationsIfNeeded,
  listSqliteMigrations,
  resolveSqliteDatabaseFilePath,
  resolveSqliteMigrationsDir,
  type SqliteMigrationExecutor,
} from './sqliteMigrations';

type SqliteState = {
  tables: Set<string>;
  applied: Map<string, string>;
  closeCount: number;
  busyTimeoutMs: number | null;
};
type NodeSqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => {
    all: () => unknown[];
    get: (...args: unknown[]) => unknown;
    run: (...args: unknown[]) => unknown;
  };
  close: () => void;
};

// This checkout's @types/node predates node:sqlite; keep the runtime boundary typed locally.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

const sqliteStore = new Map<string, SqliteState>();

function getSqliteState(databasePath: unknown): SqliteState {
  const key = String(databasePath ?? '');
  if (!sqliteStore.has(key)) {
    sqliteStore.set(key, { tables: new Set(), applied: new Map(), closeCount: 0, busyTimeoutMs: null });
  }
  return sqliteStore.get(key)!;
}

function extractCreatedTableNames(sql: unknown): string[] {
  const result: string[] = [];
  const text = String(sql ?? '');
  const regex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`[]?([A-Za-z0-9_]+)["'`\]]?/gi;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(text))) {
    const name = match[1] ?? '';
    if (name) result.push(name);
  }
  return result;
}

class FakeDatabase {
  databasePath: string;
  state: SqliteState;

  constructor(databasePath: unknown) {
    this.databasePath = String(databasePath ?? '');
    this.state = getSqliteState(this.databasePath);
  }

  exec(sql: unknown): void {
    const text = String(sql ?? '').trim();
    if (!text) return;
    const busyTimeout = /^PRAGMA\s+busy_timeout=(\d+);?$/i.exec(text);
    if (busyTimeout) {
      this.state.busyTimeoutMs = Number(busyTimeout[1]);
      return;
    }
    const upper = text.toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') return;
    for (const table of extractCreatedTableNames(text)) {
      if (this.state.tables.has(table)) {
        throw new Error(`table ${table} already exists`);
      }
      this.state.tables.add(table);
    }
  }

  query(queryText: unknown): { all?: () => Array<{ name?: string; migration_name?: string }>; run?: (...args: any[]) => void } {
    const text = String(queryText ?? '');
    if (text.includes("FROM sqlite_master")) {
      return {
        all: () => Array.from(this.state.tables).map((name) => ({ name })),
      };
    }
    if (text.includes('FROM _prisma_migrations')) {
      return {
        all: () => Array.from(this.state.applied).map(([migration_name, checksum]) => ({ migration_name, checksum })),
      };
    }
    if (text.startsWith('INSERT INTO _prisma_migrations')) {
      return {
        run: (_id: unknown, checksum: unknown, name: unknown) => {
          this.state.applied.set(String(name ?? '').trim(), String(checksum ?? ''));
        },
      };
    }
    throw new Error(`Unexpected bun:sqlite query: ${text}`);
  }

  close(): void {
    this.state.closeCount += 1;
  }
}

vi.mock('bun:sqlite', () => ({ Database: FakeDatabase }));

function createNodeSqliteExecutor(db: NodeSqliteDatabase): SqliteMigrationExecutor {
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    queryTableNames: () => {
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    },
    queryAppliedMigrations: () => {
      return db.prepare(
        `SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`,
      ).all().map((row) => ({
        name: String((row as { migration_name?: string }).migration_name ?? ''),
        checksum: String((row as { checksum?: string }).checksum ?? ''),
      }));
    },
    insertAppliedMigration: ({ name, checksum }) => {
      db.prepare(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
      ).run(randomUUID(), checksum, name);
    },
  };
}

describe('light sqlite migrations (unit)', () => {
  beforeEach(() => {
    sqliteStore.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolveSqliteDatabaseFilePath parses file: DATABASE_URL values', () => {
    expect(resolveSqliteDatabaseFilePath('file:/tmp/happier.sqlite')).toBe('/tmp/happier.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:///tmp/happier.sqlite')).toBe('/tmp/happier.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:///tmp/happy%20server%20%23light/happier.sqlite')).toBe('/tmp/happy%20server%20%23light/happier.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:/tmp/happy#server/happier.sqlite?socket_timeout=30')).toBe('/tmp/happy#server/happier.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:relative.sqlite')).toBe('relative.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:relative.sqlite?socket_timeout=30')).toBe('relative.sqlite');
    expect(resolveSqliteDatabaseFilePath('file:/tmp/%zz.sqlite?socket_timeout=30#fragment')).toBe('/tmp/%zz.sqlite');
  });

  it('listSqliteMigrations returns migration.sql entries in directory name order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-test-'));
    const m1 = join(dir, '20260101000000_first');
    const m2 = join(dir, '20260201000000_second');
    await mkdir(m2, { recursive: true });
    await mkdir(m1, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE one(id INTEGER);\n', 'utf8');
    await writeFile(join(m2, 'migration.sql'), 'CREATE TABLE two(id INTEGER);\n', 'utf8');

    const migrations = await listSqliteMigrations(dir);
    expect(migrations.map((m) => m.name)).toEqual(['20260101000000_first', '20260201000000_second']);
    expect(migrations[0]?.sql).toContain('CREATE TABLE one');
    expect(migrations[1]?.sql).toContain('CREATE TABLE two');
  });

  it('listSqliteMigrations rejects migration directories with missing or empty SQL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-invalid-'));
    const missing = join(dir, '20260101000000_missing');
    const empty = join(dir, '20260201000000_empty');
    await mkdir(missing, { recursive: true });

    await expect(listSqliteMigrations(dir)).rejects.toThrow(/missing migration\.sql/i);

    await writeFile(join(missing, 'migration.sql'), 'SELECT 1;\n', 'utf8');
    await mkdir(empty, { recursive: true });
    await writeFile(join(empty, 'migration.sql'), ' \n', 'utf8');

    await expect(listSqliteMigrations(dir)).rejects.toThrow(/empty migration\.sql/i);
  });

  it('executor policy rejects unsafe partial legacy state without recording a finished migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-partial-'));
    const migrationName = '20260101000000_partial';
    const migrationDir = join(dir, migrationName);
    await mkdir(migrationDir, { recursive: true });
    await writeFile(
      join(migrationDir, 'migration.sql'),
      'CREATE TABLE Account(id INTEGER);\nCREATE TABLE IF NOT EXISTS Widget(id INTEGER);\n',
      'utf8',
    );

    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE Account(id INTEGER);');
      const executor = createNodeSqliteExecutor(db);

      await expect(applySqliteMigrations({ executor, migrationsDir: dir })).rejects.toThrow(
        /cannot be marked applied safely/i,
      );

      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='Widget'`).get()).toBeUndefined();
      expect(
        db.prepare(`SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?`).get(migrationName),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('executor policy records missing legacy history when only verified absence cleanup remains', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-legacy-cleanup-'));
    const migrationName = '20260101000000_cleanup';
    const migrationDir = join(dir, migrationName);
    await mkdir(migrationDir, { recursive: true });
    await writeFile(
      join(migrationDir, 'migration.sql'),
      ['BEGIN;', 'DROP INDEX IF EXISTS Account_old_idx;', 'COMMIT;'].join('\n'),
      'utf8',
    );

    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE Account(id INTEGER);');
      const executor = createNodeSqliteExecutor(db);

      await expect(applySqliteMigrations({ executor, migrationsDir: dir })).resolves.toEqual({
        applied: [migrationName],
      });
      expect(
        db.prepare(`SELECT migration_name FROM _prisma_migrations WHERE migration_name = ?`).get(migrationName),
      ).toMatchObject({ migration_name: migrationName });
    } finally {
      db.close();
    }
  });

  it('resolveSqliteMigrationsDir expands ~/ overrides against HOME', () => {
    expect(resolveSqliteMigrationsDir({
      HOME: '/scoped/home',
      HAPPIER_SQLITE_MIGRATIONS_DIR: '~/migrations/sqlite',
    }, '/fallback')).toBe('/scoped/home/migrations/sqlite');
  });

  it('applySqliteMigrationsIfNeeded applies missing migrations when auto-migrate is enabled', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-apply-'));
    const m1 = join(dir, '20260101000000_first');
    const m2 = join(dir, '20260201000000_second');
    await mkdir(m1, { recursive: true });
    await mkdir(m2, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');
    await writeFile(join(m2, 'migration.sql'), 'CREATE TABLE Widget(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}?socket_timeout=7`,
    };

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });
    expect(res.applied).toEqual(['20260101000000_first', '20260201000000_second']);
    const state = getSqliteState(dbPath);
    expect(state.tables.has('Account')).toBe(true);
    expect(state.tables.has('Widget')).toBe(true);
    expect(state.applied.has('20260101000000_first')).toBe(true);
    expect(state.applied.has('20260201000000_second')).toBe(true);
    expect(state.busyTimeoutMs).toBe(7_000);
  });

  it('applySqliteMigrationsIfNeeded no-ops when auto-migrate is disabled', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-disabled-'));
    const m1 = join(dir, '20260101000000_first');
    await mkdir(m1, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-disabled-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '0',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });

    expect(res.applied).toEqual([]);
    expect(sqliteStore.has(dbPath)).toBe(false);
  });

  it('applySqliteMigrationsFromEnvironment runs the canonical owner for explicit migrate-only invocation', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-explicit-'));
    const migration = join(dir, '20260101000000_first');
    await mkdir(migration, { recursive: true });
    await writeFile(join(migration, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-explicit-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '0',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    await expect(applySqliteMigrationsFromEnvironment({ env, dataDir })).resolves.toEqual({
      applied: ['20260101000000_first'],
    });
    expect(getSqliteState(dbPath).applied.has('20260101000000_first')).toBe(true);
  });

  it('applySqliteMigrationsIfNeeded closes the Bun sqlite connection before Prisma starts', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-close-'));
    const m1 = join(dir, '20260101000000_first');
    await mkdir(m1, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-close-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    await applySqliteMigrationsIfNeeded({ env, dataDir });

    expect(getSqliteState(dbPath).closeCount).toBe(1);
  });

  it('applySqliteMigrationsIfNeeded applies new migrations even when core tables already exist', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-upgrade-'));
    const m1 = join(dir, '20260101000000_first');
    const m2 = join(dir, '20260201000000_second');
    await mkdir(m1, { recursive: true });
    await mkdir(m2, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');
    await writeFile(join(m2, 'migration.sql'), 'CREATE TABLE Widget(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-upgrade-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const state = getSqliteState(dbPath);
    state.tables.add('Account');
    state.applied.set(
      '20260101000000_first',
      createHash('sha256').update('CREATE TABLE Account(id INTEGER);\n').digest('hex'),
    );

    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });
    expect(res.applied).toEqual(['20260201000000_second']);
    expect(state.tables.has('Widget')).toBe(true);
    expect(state.applied.has('20260201000000_second')).toBe(true);
  });

  it('applySqliteMigrationsIfNeeded rejects unverifiable legacy databases without migration history', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-legacy-'));
    const m1 = join(dir, '20260101000000_first');
    const m2 = join(dir, '20260201000000_second');
    await mkdir(m1, { recursive: true });
    await mkdir(m2, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');
    await writeFile(join(m2, 'migration.sql'), 'CREATE TABLE Widget(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-legacy-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const state = getSqliteState(dbPath);
    state.tables.add('Account');

    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    await expect(applySqliteMigrationsIfNeeded({ env, dataDir })).rejects.toThrow(
      /cannot be marked applied safely/i,
    );
    expect(state.tables.has('Widget')).toBe(false);
    expect(state.applied.has('20260101000000_first')).toBe(false);
    expect(state.applied.has('20260201000000_second')).toBe(false);
  });
});
