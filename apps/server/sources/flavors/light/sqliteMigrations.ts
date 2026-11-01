import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  readPrismaSqliteConnectionParams,
  resolvePrismaSqliteDatabaseFilePath as resolveSqliteDatabaseFilePath,
} from '@happier-dev/cli-common/firstPartyRuntime';

import { parseBooleanEnv } from '@/config/env';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

type SqliteMigration = Readonly<{
  name: string;
  sql: string;
  checksum: string;
}>;

type AppliedMigrationRecord = Readonly<{
  name: string;
  checksum: string;
}>;

type MaybePromise<T> = T | Promise<T>;

export type SqliteMigrationExecutor = Readonly<{
  exec: (sql: string) => MaybePromise<void>;
  queryTableNames: () => MaybePromise<Set<string>>;
  queryAppliedMigrations: () => MaybePromise<ReadonlyArray<AppliedMigrationRecord>>;
  insertAppliedMigration: (params: { name: string; checksum: string }) => MaybePromise<void>;
}>;

type CloseableSqliteMigrationExecutor = SqliteMigrationExecutor & Readonly<{
  close: () => void;
}>;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeSqlError(error: unknown): string {
  return String((error as { message?: string })?.message ?? error ?? '').toLowerCase();
}

function isLikelyAlreadyAppliedError(error: unknown): boolean {
  const message = normalizeSqlError(error);
  return message.includes('already exists') || message.includes('duplicate column') || message.includes('duplicate');
}

function isLikelyNestedTransactionWrapperError(error: unknown): boolean {
  const message = normalizeSqlError(error);
  return (
    message.includes('cannot start a transaction within a transaction') ||
    message.includes('already a transaction') ||
    message.includes('transaction is active')
  );
}

function normalizeChecksum(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

function createChecksumMismatchError(migration: SqliteMigration, appliedChecksum: string): Error {
  return new Error(
    `[sqlite-migrations] checksum mismatch for applied migration ${migration.name}: recorded=${normalizeChecksum(appliedChecksum) || '<empty>'} current=${migration.checksum}`,
  );
}

function createUnsafeAlreadyAppliedMigrationError(migration: SqliteMigration, originalError: unknown): Error {
  const details = String((originalError as { message?: string })?.message ?? originalError ?? '').trim();
  return new Error(
    details
      ? `[sqlite-migrations] migration ${migration.name} cannot be marked applied safely: ${details}`
      : `[sqlite-migrations] migration ${migration.name} cannot be marked applied safely`,
  );
}

function createInvalidMigrationSqlError(migrationName: string, reason: string): Error {
  return new Error(`[sqlite-migrations] ${reason} for migration ${migrationName}`);
}

function splitMigrationStatements(sql: string): string[] {
  return String(sql ?? '')
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => `${statement};`);
}

function normalizeSqlStatement(statement: string): string {
  return String(statement ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '')
    .toLowerCase();
}

function isLegacyTransactionWrapperStatement(statement: string): boolean {
  const normalized = normalizeSqlStatement(statement);
  return (
    normalized === 'begin' ||
    normalized === 'begin transaction' ||
    normalized === 'start transaction' ||
    normalized === 'commit' ||
    normalized === 'commit transaction' ||
    normalized === 'end' ||
    normalized === 'rollback' ||
    normalized === 'rollback transaction' ||
    normalized.startsWith('savepoint ') ||
    normalized.startsWith('release savepoint ') ||
    normalized.startsWith('rollback to savepoint ')
  );
}

// Duplicate-name errors prove object identity, not columns, constraints, or nullability.
// Only operations whose required end state is absence can be reconciled without introspection.
function isSafeLegacyAbsenceStatement(statement: string): boolean {
  const normalized = normalizeSqlStatement(statement);
  return (
    /^drop\s+(index|table|view|sequence|trigger)\s+if\s+exists\b/.test(normalized) ||
    /^alter\s+table\b.+\bdrop\s+(column|constraint)\s+if\s+exists\b/.test(normalized)
  );
}

function mapAppliedMigrations(rows: ReadonlyArray<AppliedMigrationRecord>): Map<string, string> {
  const applied = new Map<string, string>();
  for (const row of rows) {
    const name = String(row.name ?? '').trim();
    if (name) {
      applied.set(name, normalizeChecksum(row.checksum));
    }
  }
  return applied;
}

function ensureAppliedMigrationChecksum(
  migration: SqliteMigration,
  appliedChecksums: ReadonlyMap<string, string>,
): void {
  const appliedChecksum = appliedChecksums.get(migration.name);
  if (appliedChecksum == null) {
    return;
  }
  if (appliedChecksum !== migration.checksum) {
    throw createChecksumMismatchError(migration, appliedChecksum);
  }
}

async function canSafelyRecordAlreadyAppliedMigration(params: Readonly<{
  migration: SqliteMigration;
  executor: SqliteMigrationExecutor;
}>): Promise<boolean> {
  const statements = splitMigrationStatements(params.migration.sql);
  let probedStatements = 0;

  await params.executor.exec('BEGIN');
  try {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]!;
      if (isLegacyTransactionWrapperStatement(statement)) {
        continue;
      }
      if (!isSafeLegacyAbsenceStatement(statement)) {
        return false;
      }
      probedStatements += 1;
      const savepointName = `legacy_probe_${index + 1}`;
      await params.executor.exec(`SAVEPOINT ${savepointName}`);
      try {
        await params.executor.exec(statement);
        try {
          await params.executor.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch {
          // best-effort cleanup; the outer rollback remains authoritative
        }
        try {
          await params.executor.exec(`RELEASE SAVEPOINT ${savepointName}`);
        } catch {
          // best-effort cleanup; the outer rollback remains authoritative
        }
      } catch {
        try {
          await params.executor.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        } catch {
          // best-effort cleanup; the outer rollback remains authoritative
        }
        try {
          await params.executor.exec(`RELEASE SAVEPOINT ${savepointName}`);
        } catch {
          // best-effort cleanup; the outer rollback remains authoritative
        }
        return false;
      }
    }
  } finally {
    try {
      await params.executor.exec('ROLLBACK');
    } catch {
      // the probe never commits; ignore only an already-ended transaction
    }
  }

  return probedStatements > 0;
}

export { resolveSqliteDatabaseFilePath };

export function resolveSqliteMigrationBusyTimeoutMs(databaseUrl: string): number {
  const socketTimeoutSecondsRaw = readPrismaSqliteConnectionParams(databaseUrl).get('socket_timeout');
  if (socketTimeoutSecondsRaw == null) return 0;
  if (!/^\d+$/.test(socketTimeoutSecondsRaw)) {
    throw new Error(`[sqlite-migrations] invalid DATABASE_URL socket_timeout: ${socketTimeoutSecondsRaw}`);
  }
  const socketTimeoutSeconds = Number(socketTimeoutSecondsRaw);
  if (!Number.isSafeInteger(socketTimeoutSeconds) || socketTimeoutSeconds > 600) {
    throw new Error(`[sqlite-migrations] invalid DATABASE_URL socket_timeout: ${socketTimeoutSecondsRaw}`);
  }
  return socketTimeoutSeconds * 1_000;
}

export async function listSqliteMigrations(migrationsDir: string): Promise<SqliteMigration[]> {
  const rawDir = String(migrationsDir ?? '').trim();
  if (!rawDir) {
    throw new Error('SQLite migrations directory is missing: <empty>');
  }
  const dir = resolve(rawDir);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
    throw new Error(`SQLite migrations directory is missing: ${dir}`);
  });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const result: SqliteMigration[] = [];
  for (const name of dirs) {
    const sqlPath = join(dir, name, 'migration.sql');
    let sql: string;
    try {
      sql = await readFile(sqlPath, 'utf8');
    } catch {
      throw createInvalidMigrationSqlError(name, 'missing migration.sql');
    }
    if (!sql.trim()) {
      throw createInvalidMigrationSqlError(name, 'empty migration.sql');
    }
    result.push(Object.freeze({ name, sql, checksum: sha256Hex(sql) }));
  }
  return result;
}

export function shouldAutoMigrateSqliteOnStart(env: NodeJS.ProcessEnv): boolean {
  return parseBooleanEnv(env.HAPPIER_SQLITE_AUTO_MIGRATE ?? env.HAPPY_SQLITE_AUTO_MIGRATE, false);
}

export function resolveSqliteMigrationsDir(env: NodeJS.ProcessEnv, dataDir: string): string {
  const explicit = expandHomeDirPath(
    String(env.HAPPIER_SQLITE_MIGRATIONS_DIR ?? env.HAPPY_SQLITE_MIGRATIONS_DIR ?? '').trim(),
    env,
  );
  if (explicit) return explicit;
  const base = String(dataDir ?? '').trim();
  return base ? join(base, 'migrations', 'sqlite') : '';
}

async function createBunSqliteExecutor(params: {
  databasePath: string;
  busyTimeoutMs: number;
}): Promise<CloseableSqliteMigrationExecutor> {
  const mod = await import('bun:sqlite');
  const Database = mod?.Database;
  if (!Database) {
    throw new Error('bun:sqlite Database is unavailable (expected Bun runtime)');
  }
  const db = new Database(params.databasePath);
  db.exec(`PRAGMA busy_timeout=${params.busyTimeoutMs};`);

  return Object.freeze({
    exec: (sql: string) => {
      db.exec(sql);
    },
    queryTableNames: () => {
      const rows = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all();
      const set = new Set<string>();
      for (const row of rows) {
        const name = String(row?.name ?? '').trim();
        if (name) set.add(name);
      }
      return set;
    },
    queryAppliedMigrations: () => {
      const rows = db.query(
        `SELECT migration_name, checksum FROM _prisma_migrations WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`,
      ).all();
      const result: AppliedMigrationRecord[] = [];
      for (const row of rows) {
        const name = String(row?.migration_name ?? '').trim();
        if (!name) continue;
        result.push({
          name,
          checksum: String((row as { checksum?: string }).checksum ?? ''),
        });
      }
      return result;
    },
    insertAppliedMigration: ({ name, checksum }: { name: string; checksum: string }) => {
      db.query(
        `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)`,
      ).run(randomUUID(), checksum, name);
    },
    close: () => {
      if (typeof db.close === 'function') {
        db.close();
      }
    },
  });
}

export async function applySqliteMigrations(params: Readonly<{
  executor: SqliteMigrationExecutor;
  migrationsDir: string;
}>): Promise<{ applied: string[] }> {
  await params.executor.exec(
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

  const migrations = await listSqliteMigrations(params.migrationsDir);
  const appliedChecksums = mapAppliedMigrations(await params.executor.queryAppliedMigrations());
  const applied = new Set(appliedChecksums.keys());
  const existingTables = await params.executor.queryTableNames();
  const hasCoreTables = existingTables.has('Account') || existingTables.has('account') || existingTables.has('accounts');
  const legacyMode = applied.size === 0 && hasCoreTables;

  const appliedNow: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) {
      ensureAppliedMigrationChecksum(migration, appliedChecksums);
      continue;
    }
    await params.executor.exec('BEGIN');
    try {
      await params.executor.exec(migration.sql);
      await params.executor.insertAppliedMigration({ name: migration.name, checksum: migration.checksum });
      await params.executor.exec('COMMIT');
      appliedNow.push(migration.name);
      applied.add(migration.name);
      appliedChecksums.set(migration.name, migration.checksum);
    } catch (error) {
      try {
        await params.executor.exec('ROLLBACK');
      } catch {
        // ignore only a transaction that the migration SQL already ended
      }
      const canBackfillMissingMigrationRecord = legacyMode || applied.size > 0;
      if (
        canBackfillMissingMigrationRecord &&
        (isLikelyAlreadyAppliedError(error) || isLikelyNestedTransactionWrapperError(error))
      ) {
        const safeMissingRecordBackfill = await canSafelyRecordAlreadyAppliedMigration({
          migration,
          executor: params.executor,
        });
        if (!safeMissingRecordBackfill) {
          throw createUnsafeAlreadyAppliedMigrationError(migration, error);
        }
        await params.executor.insertAppliedMigration({ name: migration.name, checksum: migration.checksum });
        appliedNow.push(migration.name);
        applied.add(migration.name);
        appliedChecksums.set(migration.name, migration.checksum);
        continue;
      }
      throw error;
    }
  }

  return { applied: appliedNow };
}

export async function applySqliteMigrationsFromEnvironment(params: Readonly<{
  env: NodeJS.ProcessEnv;
  dataDir: string;
}>): Promise<{ applied: string[] }> {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    throw new Error('[sqlite-migrations] explicit SQLite migration requires the Bun runtime');
  }
  const migrationsDir = resolveSqliteMigrationsDir(params.env, params.dataDir);
  if (!migrationsDir || !existsSync(migrationsDir)) {
    throw new Error(`SQLite migrations directory is missing: ${migrationsDir || '<empty>'}`);
  }
  const databaseUrl = String(params.env.DATABASE_URL ?? '').trim();
  const dbPath = resolveSqliteDatabaseFilePath(databaseUrl);
  if (!dbPath) {
    throw new Error('SQLite auto-migrate requires DATABASE_URL=file:... to be set');
  }
  await mkdir(dirname(dbPath), { recursive: true }).catch(() => {});

  const executor = await createBunSqliteExecutor({
    databasePath: dbPath,
    busyTimeoutMs: resolveSqliteMigrationBusyTimeoutMs(databaseUrl),
  });
  try {
    return await applySqliteMigrations({ executor, migrationsDir });
  } finally {
    executor.close();
  }
}

export async function applySqliteMigrationsIfNeeded(params: Readonly<{
  env: NodeJS.ProcessEnv;
  dataDir: string;
}>): Promise<{ applied: string[] }> {
  if (typeof (globalThis as { Bun?: unknown }).Bun === 'undefined') {
    return { applied: [] };
  }
  if (!shouldAutoMigrateSqliteOnStart(params.env)) {
    return { applied: [] };
  }
  return await applySqliteMigrationsFromEnvironment(params);
}
