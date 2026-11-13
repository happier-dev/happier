import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import {
  findCodexRolloutFileById,
  resolveCodexLogicalRolloutPath,
  resolveExistingCodexRolloutPath,
} from '@/backends/codex/utils/codexSessionFiles';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import { resolveConfiguredCodexSqliteHome } from './codexStateFileNames';

const CODEX_STATE_DATABASE_FILE_NAME = 'state_5.sqlite';

type RolloutPathRow = Readonly<{ rollout_path: string }>;

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function readRolloutPath(
  database: SqliteDatabaseSync,
  vendorResumeId: string,
): string | null {
  const row = database
    .prepare('SELECT rollout_path FROM threads WHERE id = ?')
    .get(vendorResumeId);
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const rolloutPath = (row as Partial<RolloutPathRow>).rollout_path;
  return typeof rolloutPath === 'string' && rolloutPath.trim().length > 0
    ? rolloutPath.trim()
    : null;
}

/** Reads the native resume authority without creating an index or repairing its rows. */
export async function resolveExistingCodexIndexedRolloutPath(params: Readonly<{
  env: NodeJS.ProcessEnv;
  vendorResumeId: string;
  cwd: string;
}>): Promise<string | null> {
  const databasePath = join(resolveConfiguredCodexSqliteHome(params.env, params.cwd), CODEX_STATE_DATABASE_FILE_NAME);
  let database: SqliteDatabaseSync | null = null;
  try {
    database = openSqliteDatabaseSync(databasePath, { readOnly: true });
    const indexedPath = readRolloutPath(database, params.vendorResumeId);
    return indexedPath ? await resolveExistingCodexRolloutPath(indexedPath) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/**
 * Reconciles the one Codex index field required to resume an already-proven rollout.
 *
 * Shared Connected Services intentionally keeps Codex's SQLite catalog in one stable native home
 * while materialized homes can be replaced. Older rows can therefore retain an absolute path into a
 * materialized home that no longer exists even though state sharing preserved the exact rollout in
 * the current home. Codex resolves `thread/resume` through that row before opening the rollout.
 *
 * This is deliberately not a reindexer: it never creates a database, table, or thread row, and it
 * changes only the exact requested row when its current path is missing. The compare-and-set mirrors
 * Codex's own `replace_rollout_path_if_current` contract, so a concurrent provider update wins.
 */
export async function reconcileCodexResumeRolloutPath(params: Readonly<{
  targetMaterializedEnv: Readonly<Record<string, string>>;
  vendorResumeId: string;
  resolvedRolloutPath: string;
  cwd: string;
}>): Promise<boolean> {
  const rawCodexHome = params.targetMaterializedEnv.CODEX_HOME?.trim() ?? '';
  const rawSqliteHome = params.targetMaterializedEnv.CODEX_SQLITE_HOME?.trim() ?? '';
  if (!rawCodexHome || !rawSqliteHome) return true;

  const codexHome = resolve(resolveConfiguredCodexHome(params.targetMaterializedEnv));
  const sqliteHome = resolve(resolveConfiguredCodexSqliteHome(params.targetMaterializedEnv, params.cwd));
  if (codexHome === sqliteHome) return true;

  const databasePath = join(sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
  if (!await isFile(databasePath)) return true;

  let database: SqliteDatabaseSync | null = null;
  try {
    database = openSqliteDatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 5000');

    const table = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
      .get();
    if (!table) return true;

    return await replaceMissingRolloutPath(database, params.vendorResumeId, params.resolvedRolloutPath);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

async function replaceMissingRolloutPath(
  database: SqliteDatabaseSync,
  vendorResumeId: string,
  resolvedRolloutPath: string,
): Promise<boolean> {
  const indexedPath = readRolloutPath(database, vendorResumeId);
  if (!indexedPath || indexedPath === resolvedRolloutPath) return true;
  if (await resolveExistingCodexRolloutPath(indexedPath)) return true;

  database
    .prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
    .run(resolveCodexLogicalRolloutPath(resolvedRolloutPath), vendorResumeId, indexedPath);

  const settledPath = readRolloutPath(database, vendorResumeId);
  return settledPath !== null && await resolveExistingCodexRolloutPath(settledPath) !== null;
}

/**
 * The same one-row reconciliation for a thread in its own native Codex home.
 *
 * Codex history copied from another machine (e.g. Codex Desktop on Windows) keeps rows whose
 * rollout_path names that machine's file, so Codex refuses `thread/resume` ("no rollout found") even
 * though the exact rollout sits in this home's session store. Only a row whose recorded path is
 * missing is touched, and only to point at the same-id rollout found under this home's `sessions/`.
 * Returns false when the row still cannot be resolved.
 */
export async function reconcileNativeCodexResumeRolloutPath(params: Readonly<{
  env: NodeJS.ProcessEnv;
  vendorResumeId: string;
  cwd: string;
}>): Promise<boolean> {
  const databasePath = join(resolveConfiguredCodexSqliteHome(params.env, params.cwd), CODEX_STATE_DATABASE_FILE_NAME);
  if (!await isFile(databasePath)) return true;
  let database: SqliteDatabaseSync | null = null;
  try {
    database = openSqliteDatabaseSync(databasePath, { readOnly: true });
    const indexedPath = readRolloutPath(database, params.vendorResumeId);
    database.close();
    database = null;
    if (!indexedPath || await resolveExistingCodexRolloutPath(indexedPath)) return true;

    const localRollout = await findCodexRolloutFileById({
      sessionsRoot: join(resolve(resolveConfiguredCodexHome(params.env)), 'sessions'),
      vendorResumeId: params.vendorResumeId,
    });
    if (!localRollout) return false;

    database = openSqliteDatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    return await replaceMissingRolloutPath(database, params.vendorResumeId, localRollout);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
