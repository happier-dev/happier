import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveConfiguredCodexHome } from '@/backends/codex/utils/resolveConfiguredCodexHome';
import { readCodexSessionMetaFromRollout } from '@/backends/codex/localControl/rolloutDiscovery';
import {
  findCodexRolloutFileById,
  isMatchingCodexRolloutFileName,
  isMatchingCodexRolloutIdentity,
  normalizeCodexVendorResumeId,
  resolveCodexLogicalRolloutPath,
  resolveExistingCodexRolloutPath,
} from '@/backends/codex/utils/codexSessionFiles';
import { openSqliteDatabaseSync, type SqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';

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
    ? rolloutPath
    : null;
}

async function findVerifiedMovedRollout(codexHome: string, indexedPath: string, id: string): Promise<string | null> {
  const recordedFileName = resolveCodexLogicalRolloutPath(indexedPath.split(/[\\/]/u).at(-1) ?? '');
  if (!isMatchingCodexRolloutFileName(recordedFileName, id)) return null;
  const localRollout = await findCodexRolloutFileById({ sessionsRoot: join(codexHome, 'sessions'), vendorResumeId: id, recordedFileName });
  if (!localRollout) return null;
  const meta = await readCodexSessionMetaFromRollout(localRollout);
  return isMatchingCodexRolloutIdentity(meta?.id, id) ? localRollout : null;
}

/** Reads the native resume authority without creating an index or repairing its rows. */
export async function resolveExistingCodexIndexedRolloutPath(params: Readonly<{
  sqliteHome: string;
  vendorResumeId: string;
  codexHome?: string;
}>): Promise<string | null> {
  const databasePath = join(params.sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
  let database: SqliteDatabaseSync | null = null;
  try {
    database = openSqliteDatabaseSync(databasePath, { readOnly: true });
    const indexedPath = readRolloutPath(database, params.vendorResumeId);
    if (!indexedPath) return null;
    return await resolveExistingCodexRolloutPath(indexedPath) ?? (params.codexHome
      ? await findVerifiedMovedRollout(params.codexHome, indexedPath, params.vendorResumeId)
      : null);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

/** Repairs only the recorded path of an existing thread row. */
export async function reconcileCodexResumeRolloutPath(params: Readonly<{
  env: NodeJS.ProcessEnv;
  vendorResumeId: string;
  cwd: string;
  sqliteHome: string | null;
  /** The Connected Account reachability check already established this rollout. */
  resolvedRolloutPath?: string;
}>): Promise<boolean> {
  const id = normalizeCodexVendorResumeId(params.vendorResumeId);
  if (!id) return false;
  const { sqliteHome } = params;
  if (!sqliteHome) return false;
  const databasePath = join(sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
  if (!await isFile(databasePath)) return true;

  let database: SqliteDatabaseSync | null = null;
  try {
    database = openSqliteDatabaseSync(databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get()) return true;
    const indexedPath = readRolloutPath(database, id);
    if (!indexedPath || await resolveExistingCodexRolloutPath(indexedPath)) return true;

    const nextPath = params.resolvedRolloutPath
      ?? await findVerifiedMovedRollout(resolve(params.cwd, resolveConfiguredCodexHome(params.env)), indexedPath, id);
    if (!nextPath) return false;

    const result = database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      .run(resolveCodexLogicalRolloutPath(nextPath), id, indexedPath);
    if (result && typeof result === 'object' && 'changes' in result && result.changes) return true;
    const settled = readRolloutPath(database, id);
    return settled !== null && await resolveExistingCodexRolloutPath(settled) !== null;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
