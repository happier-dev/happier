import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applySqliteMigrationsIfNeeded, listSqliteMigrations, resolveSqliteDatabaseFilePath } from './sqliteMigrations';

const sqliteStore = new Map();

function getSqliteState(databasePath) {
  const key = String(databasePath ?? '');
  if (!sqliteStore.has(key)) {
    sqliteStore.set(key, { tables: new Set(), applied: new Set() });
  }
  return sqliteStore.get(key);
}

function extractCreatedTableNames(sql) {
  const result = [];
  const text = String(sql ?? '');
  const regex = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["'`[]?([A-Za-z0-9_]+)["'`\]]?/gi;
  let match;
  // eslint-disable-next-line no-cond-assign
  while ((match = regex.exec(text))) {
    const name = match[1];
    if (name) result.push(name);
  }
  return result;
}

class FakeDatabase {
  constructor(databasePath) {
    this.databasePath = String(databasePath ?? '');
    this.state = getSqliteState(this.databasePath);
  }

  exec(sql) {
    const text = String(sql ?? '').trim();
    if (!text) return;
    const upper = text.toUpperCase();
    if (upper === 'BEGIN' || upper === 'COMMIT' || upper === 'ROLLBACK') return;
    for (const table of extractCreatedTableNames(text)) {
      if (this.state.tables.has(table)) {
        throw new Error(`table ${table} already exists`);
      }
      this.state.tables.add(table);
    }
  }

  query(queryText) {
    const text = String(queryText ?? '');
    if (text.includes("FROM sqlite_master")) {
      return {
        all: () => Array.from(this.state.tables).map((name) => ({ name })),
      };
    }
    if (text.includes('FROM _prisma_migrations')) {
      return {
        all: () => Array.from(this.state.applied).map((migration_name) => ({ migration_name })),
      };
    }
    if (text.startsWith('INSERT INTO _prisma_migrations')) {
      return {
        run: (_id, checksum, name) => {
          void checksum;
          this.state.applied.add(String(name ?? '').trim());
        },
      };
    }
    throw new Error(`Unexpected bun:sqlite query: ${text}`);
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
      DATABASE_URL: `file:${dbPath}`,
    };

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });
    expect(res.applied).toEqual(['20260101000000_first', '20260201000000_second']);
    const state = getSqliteState(dbPath);
    expect(state.tables.has('Account')).toBe(true);
    expect(state.tables.has('Widget')).toBe(true);
    expect(state.applied.has('20260101000000_first')).toBe(true);
    expect(state.applied.has('20260201000000_second')).toBe(true);
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
    state.applied.add('20260101000000_first');

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

  it('applySqliteMigrationsIfNeeded tolerates legacy databases without migration history', async () => {
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

    const res = await applySqliteMigrationsIfNeeded({ env, dataDir });
    expect(res.applied).toEqual(['20260101000000_first', '20260201000000_second']);
    expect(state.tables.has('Widget')).toBe(true);
    expect(state.applied.has('20260101000000_first')).toBe(true);
    expect(state.applied.has('20260201000000_second')).toBe(true);
  });
});
