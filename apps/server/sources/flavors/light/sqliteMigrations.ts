import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

type SqliteMigration = Readonly<{
  name: string;
  sql: string;
  checksum: string;
}>;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function resolveSqliteDatabaseFilePath(databaseUrl: string): string {
  const raw = String(databaseUrl ?? '').trim();
  if (!raw) return '';
  if (!raw.startsWith('file:')) return '';
  try {
    const url = new URL(raw);
    // For file: URLs, pathname is already decoded and starts with / on unix.
    if (url.protocol !== 'file:') return '';
    // On Windows, URL.pathname can start with /C:/...
    const path = url.pathname.startsWith('/') && /^[A-Za-z]:\//.test(url.pathname.slice(1))
      ? url.pathname.slice(1)
      : url.pathname;
    return path || '';
  } catch {
    // Prisma accepts file:/path and file:relative forms; treat them as best-effort paths.
    const value = raw.slice('file:'.length);
    return value.startsWith('//') ? value.replace(/^\/+/, '/') : value;
  }
}

export async function listSqliteMigrations(migrationsDir: string): Promise<SqliteMigration[]> {
  const dir = resolve(String(migrationsDir ?? '').trim());
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const result: SqliteMigration[] = [];
  for (const name of dirs) {
    const sqlPath = join(dir, name, 'migration.sql');
    const sql = await readFile(sqlPath, 'utf8').catch(() => '');
    if (!sql.trim()) continue;
    result.push(Object.freeze({ name, sql, checksum: sha256Hex(sql) }));
  }
  return result;
}

type SqliteExecutor = Readonly<{
  exec: (sql: string) => void;
  queryTableNames: () => Set<string>;
  queryAppliedMigrations: () => Set<string>;
  insertAppliedMigration: (params: { name: string; checksum: string }) => void;
}>;

function parseBooleanEnv(raw: unknown, fallback = false): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
}

export function shouldAutoMigrateSqliteOnStart(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanEnv(env.HAPPIER_SQLITE_AUTO_MIGRATE ?? env.HAPPY_SQLITE_AUTO_MIGRATE, false);
}

export function resolveSqliteMigrationsDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const explicit = String(env.HAPPIER_SQLITE_MIGRATIONS_DIR ?? env.HAPPY_SQLITE_MIGRATIONS_DIR ?? '').trim();
  if (explicit) return explicit;
  const base = String(dataDir ?? '').trim();
  return base ? join(base, 'migrations', 'sqlite') : '';
}

async function createBunSqliteExecutor(params: { databasePath: string }): Promise<SqliteExecutor> {
  const mod = await import('bun:sqlite');
  const Database = mod?.Database;
  if (!Database) {
    throw new Error('bun:sqlite Database is unavailable (expected Bun runtime)');
  }
  const db = new Database(params.databasePath);
  db.exec(
    [
      'CREATE TABLE IF NOT EXISTS _prisma_migrations (',
      '  id TEXT PRIMARY KEY,',
      '  checksum TEXT NOT NULL,',
      '  finished_at DATETIME,',
      '  migration_name TEXT NOT NULL,',
      '  logs TEXT,',
      '  rolled_back_at DATETIME,',
      '  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  applied_steps_count INTEGER NOT NULL DEFAULT 0',
      ');',
    ].join('\n'),
  );

  const tableNamesQuery = db.query(`SELECT name FROM sqlite_master WHERE type='table'`);
  const appliedQuery = db.query(`SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`);
  const insertQuery = db.query(
    `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
  );

  return Object.freeze({
    exec: (sql) => {
      db.exec(sql);
    },
    queryTableNames: () => {
      const rows = tableNamesQuery.all();
      const set = new Set<string>();
      for (const row of rows) {
        const name = String(row?.name ?? '').trim();
        if (name) set.add(name);
      }
      return set;
    },
    queryAppliedMigrations: () => {
      const rows = appliedQuery.all();
      const set = new Set<string>();
      for (const row of rows) {
        const name = String(row?.migration_name ?? '').trim();
        if (name) set.add(name);
      }
      return set;
    },
    insertAppliedMigration: ({ name, checksum }) => {
      insertQuery.run(randomUUID(), checksum, name);
    },
  });
}

export async function applySqliteMigrationsIfNeeded(params: Readonly<{
  env: NodeJS.ProcessEnv;
  dataDir: string;
}>): Promise<{ applied: string[] }> {
  if (typeof (globalThis as any).Bun === 'undefined') {
    return { applied: [] };
  }
  if (!shouldAutoMigrateSqliteOnStart(params.env)) {
    return { applied: [] };
  }
  const migrationsDir = resolveSqliteMigrationsDir(params.env, params.dataDir);
  if (!migrationsDir || !existsSync(migrationsDir)) {
    throw new Error(`SQLite migrations directory is missing: ${migrationsDir || '<empty>'}`);
  }
  const dbPath = resolveSqliteDatabaseFilePath(String(params.env.DATABASE_URL ?? '').trim());
  if (!dbPath) {
    throw new Error('SQLite auto-migrate requires DATABASE_URL=file:... to be set');
  }
  await mkdir(dirname(dbPath), { recursive: true }).catch(() => {});

  const executor = await createBunSqliteExecutor({ databasePath: dbPath });
  const migrations = await listSqliteMigrations(migrationsDir);
  if (migrations.length === 0) {
    return { applied: [] };
  }
  const applied = executor.queryAppliedMigrations();
  const existingTables = executor.queryTableNames();
  const hasCoreTables = existingTables.has('Account') || existingTables.has('account') || existingTables.has('accounts');
  const legacyMode = applied.size === 0 && hasCoreTables;

  const isLikelyAlreadyAppliedError = (err: unknown): boolean => {
    const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
    return msg.includes('already exists') || msg.includes('duplicate column') || msg.includes('duplicate');
  };

  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    executor.exec('BEGIN');
    try {
      executor.exec(migration.sql);
      executor.insertAppliedMigration({ name: migration.name, checksum: migration.checksum });
      executor.exec('COMMIT');
      appliedNow.push(migration.name);
      applied.add(migration.name);
    } catch (err) {
      try {
        executor.exec('ROLLBACK');
      } catch {
        // ignore
      }
      if (legacyMode && isLikelyAlreadyAppliedError(err)) {
        executor.insertAppliedMigration({ name: migration.name, checksum: migration.checksum });
        appliedNow.push(migration.name);
        applied.add(migration.name);
        continue;
      }
      throw err;
    }
  }
  return { applied: appliedNow };
}
