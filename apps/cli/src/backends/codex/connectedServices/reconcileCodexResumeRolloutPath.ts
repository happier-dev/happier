import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { resolveCodexLogicalRolloutPath, resolveExistingCodexRolloutPath } from '@/backends/codex/utils/codexSessionFiles';
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

    const indexedPath = readRolloutPath(database, params.vendorResumeId);
    if (!indexedPath || indexedPath === params.resolvedRolloutPath) return true;
    if (await resolveExistingCodexRolloutPath(indexedPath)) return true;

    const logicalRolloutPath = resolveCodexLogicalRolloutPath(params.resolvedRolloutPath);

    database
      .prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      .run(logicalRolloutPath, params.vendorResumeId, indexedPath);

    const settledPath = readRolloutPath(database, params.vendorResumeId);
    return settledPath !== null && await resolveExistingCodexRolloutPath(settledPath) !== null;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
