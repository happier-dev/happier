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
import { resolveCodexSqliteLaunch } from './codexStateFileNames';

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

/** Reads the native resume authority without creating an index or repairing its rows. */
export async function resolveExistingCodexIndexedRolloutPath(params: Readonly<{
  sqliteHome: string;
  vendorResumeId: string;
}>): Promise<string | null> {
  const databasePath = join(params.sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
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

/** Repairs only the recorded path of an existing thread row. */
export async function reconcileCodexResumeRolloutPath(params: Readonly<{
  env: NodeJS.ProcessEnv;
  vendorResumeId: string;
  cwd: string;
  configOverrides?: readonly string[];
  readNativeConfig?: (method: string, params?: unknown) => Promise<unknown>;
  /** The Connected Account reachability check already established this rollout. */
  resolvedRolloutPath?: string;
}>): Promise<boolean> {
  const id = normalizeCodexVendorResumeId(params.vendorResumeId);
  if (!id) return false;
  const { sqliteHome } = await resolveCodexSqliteLaunch({ ...params, materialized: Boolean(params.resolvedRolloutPath) });
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

    let nextPath = params.resolvedRolloutPath;
    if (!nextPath) {
      const recordedFileName = resolveCodexLogicalRolloutPath(indexedPath.split(/[/\\]/u).at(-1) ?? '');
      if (!isMatchingCodexRolloutFileName(recordedFileName, id)) return false;
      const localRollout = await findCodexRolloutFileById({
        sessionsRoot: join(resolve(params.cwd, resolveConfiguredCodexHome(params.env)), 'sessions'),
        vendorResumeId: id,
        recordedFileName,
      });
      if (!localRollout) return false;
      const meta = await readCodexSessionMetaFromRollout(localRollout);
      if (!isMatchingCodexRolloutIdentity(meta?.id, id)) return false;
      nextPath = localRollout;
    }

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
