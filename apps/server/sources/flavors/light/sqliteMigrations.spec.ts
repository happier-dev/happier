import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applySqliteMigrationsFromEnvironment,
  applySqliteMigrationsIfNeeded,
  listSqliteMigrations,
  resolveSqliteDatabaseFilePath,
  resolveSqliteMigrationsDir,
} from './sqliteMigrations';

type SqliteState = {
  tables: Set<string>;
  applied: Map<string, string>;
  closeCount: number;
  execStatements: string[];
};

const sqliteStore = new Map<string, SqliteState>();

function getSqliteState(databasePath: unknown): SqliteState {
  const key = String(databasePath ?? '');
  if (!sqliteStore.has(key)) {
    sqliteStore.set(key, {
      tables: new Set(),
      applied: new Map(),
      closeCount: 0,
      execStatements: [],
    });
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
    this.state.execStatements.push(text);
    const upper = text.toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') return;
    const isCreateTableIfNotExists = upper.includes('CREATE TABLE IF NOT EXISTS');
    for (const table of extractCreatedTableNames(text)) {
      if (this.state.tables.has(table)) {
        if (isCreateTableIfNotExists) {
          continue;
        }
        throw new Error(`table ${table} already exists`);
      }
      this.state.tables.add(table);
    }
  }

  query(queryText: unknown): {
    all?: () => Array<{ name?: string; migration_name?: string; checksum?: string }>;
    run?: (...args: unknown[]) => void;
  } {
    const text = String(queryText ?? '');
    if (text.includes("FROM sqlite_master")) {
      return {
        all: () => Array.from(this.state.tables).map((name) => ({ name })),
      };
    }
    if (text.includes('FROM _prisma_migrations')) {
      return {
        all: () =>
          Array.from(this.state.applied.entries()).map(([migration_name, checksum]) => ({
            migration_name,
            checksum,
          })),
      };
    }
    if (text.startsWith('INSERT INTO _prisma_migrations')) {
      return {
        run: (_id: unknown, checksum: unknown, name: unknown) => {
          this.state.applied.set(String(name ?? '').trim(), String(checksum ?? '').trim());
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
    expect(resolveSqliteDatabaseFilePath('file:///tmp/happy%20server%20%23light/happier.sqlite')).toBe('/tmp/happy server #light/happier.sqlite');
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
    expect(state.execStatements.slice(0, 2)).toEqual([
      'PRAGMA busy_timeout=7000;',
      'PRAGMA auto_vacuum=INCREMENTAL;',
    ]);
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
    await mkdir(m1, { recursive: true });
    await writeFile(join(m1, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-upgrade-'));
    const dbPath = join(dataDir, 'happier.sqlite');

    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    await applySqliteMigrationsIfNeeded({ env, dataDir });

    const m2 = join(dir, '20260201000000_second');
    await mkdir(m2, { recursive: true });
    await writeFile(join(m2, 'migration.sql'), 'CREATE TABLE Widget(id INTEGER);\n', 'utf8');

    const state = getSqliteState(dbPath);
    state.tables.add('Account');

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });
    expect(res.applied).toEqual(['20260201000000_second']);
    expect(state.tables.has('Widget')).toBe(true);
    expect(state.applied.has('20260201000000_second')).toBe(true);
  });

  it('keeps the normal-start auto-migration gate while explicit migrate-only invocation bypasses it', async () => {
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

    await expect(applySqliteMigrationsIfNeeded({ env, dataDir })).resolves.toEqual({ applied: [] });
    expect(sqliteStore.has(dbPath)).toBe(false);

    await expect(applySqliteMigrationsFromEnvironment({ env, dataDir })).resolves.toEqual({
      applied: ['20260101000000_first'],
    });
    expect(getSqliteState(dbPath).applied.has('20260101000000_first')).toBe(true);
  });

  it('applySqliteMigrationsIfNeeded rejects checksum drift for already-applied migrations', async () => {
    vi.stubGlobal('Bun', {});
    const dir = await mkdtemp(join(tmpdir(), 'happier-sqlite-migrations-drift-'));
    const migration = join(dir, '20260101000000_first');
    await mkdir(migration, { recursive: true });
    await writeFile(join(migration, 'migration.sql'), 'CREATE TABLE Account(id INTEGER);\n', 'utf8');

    const dataDir = await mkdtemp(join(tmpdir(), 'happier-sqlite-data-drift-'));
    const dbPath = join(dataDir, 'happier.sqlite');
    const env = {
      HAPPIER_SQLITE_AUTO_MIGRATE: '1',
      HAPPIER_SQLITE_MIGRATIONS_DIR: dir,
      DATABASE_URL: `file:${dbPath}`,
    };

    await applySqliteMigrationsIfNeeded({ env, dataDir });
    await writeFile(join(migration, 'migration.sql'), 'CREATE TABLE Account(id INTEGER, name TEXT);\n', 'utf8');

    await expect(applySqliteMigrationsIfNeeded({ env, dataDir })).rejects.toThrow(/checksum mismatch/i);
  });

  it('applySqliteMigrationsIfNeeded rejects legacy schema inference from duplicate table names', async () => {
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
