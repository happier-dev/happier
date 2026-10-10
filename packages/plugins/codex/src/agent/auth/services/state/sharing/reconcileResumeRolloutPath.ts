import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  expandHomePath,
  openSqliteDatabaseSync,
  resolveHomeDirFromEnvironment,
  type SqliteDatabaseSync,
} from '@happier-dev/plugin-sdk/fs';

import {
  findCodexRolloutFileById,
} from '../../../../rollout/discovery/sessionFileSearch.js';
import { resolveConfiguredCodexHomePath } from '../../../../rollout/discovery/homeEntries.js';
import { readExactCodexVendorResumeId } from '../../home/sync/sessionFiles.js';
import { readExactCodexProviderSessionId } from '../../../../../protocol/runtimeDescriptorV1.js';
import { resolveCodexRuntimeHomeEnvironment } from './files.js';

const CODEX_STATE_DATABASE_FILE_NAME = 'state_5.sqlite';

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function readRolloutPath(database: SqliteDatabaseSync, vendorResumeId: string): string | null {
  const row = database
    .prepare('SELECT rollout_path FROM threads WHERE id = ?')
    .get(vendorResumeId);
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const rolloutPath = (row as Readonly<{ rollout_path?: unknown }>).rollout_path;
  return typeof rolloutPath === 'string' && rolloutPath.trim().length > 0
    ? rolloutPath.trim()
    : null;
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

/** Observes native resume authority without creating or repairing its index. */
export async function resolveExistingCodexIndexedRolloutPath(params: Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  cwd: string;
  vendorResumeId: string;
  signal: AbortSignal;
}>): Promise<string | null> {
  params.signal.throwIfAborted();
  const vendorResumeId = readExactCodexProviderSessionId(params.vendorResumeId);
  if (!vendorResumeId) return null;
  const codexHome = resolve(resolveConfiguredCodexHomePath(params.processEnv));
  const homeDir = resolveHomeDirFromEnvironment(params.processEnv);
  const runtimeHome = resolveCodexRuntimeHomeEnvironment({
    env: params.processEnv,
    codexHome,
    cwd: params.cwd,
    expandHomePath: rawPath => expandHomePath(rawPath, homeDir),
  });
  const databasePath = join(runtimeHome.CODEX_SQLITE_HOME, CODEX_STATE_DATABASE_FILE_NAME);
  const databaseExists = await isExistingFile(databasePath);
  params.signal.throwIfAborted();
  if (!databaseExists) return null;

  const database = openSqliteDatabaseSync(databasePath, { readOnly: true });
  try {
    params.signal.throwIfAborted();
    const table = database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
      .get();
    if (!table) return null;
    const indexedPath = readRolloutPath(database, vendorResumeId);
    if (!indexedPath) return null;
    const rolloutExists = await isExistingFile(indexedPath);
    params.signal.throwIfAborted();
    return rolloutExists ? indexedPath : null;
  } finally {
    database.close();
  }
}

/**
 * Repairs the one Codex-native index field needed by `thread/resume` after the
 * exact rollout has survived a Connected Account materialization replacement.
 *
 * The Codex plugin owns both the provider schema and this provider-operation
 * boundary. This is intentionally not a reindexer: it never creates a database,
 * table, or thread row, and it updates only a missing path through an exact
 * compare-and-set so a concurrent Codex write wins.
 */
export async function reconcileCodexResumeRolloutPath(params: Readonly<{
  processEnv: Readonly<Record<string, string | undefined>>;
  cwd: string;
  vendorResumeId: string;
}>): Promise<boolean> {
  const vendorResumeId = readExactCodexVendorResumeId(params.vendorResumeId);
  if (!vendorResumeId) return false;

  const rawCodexHome = params.processEnv.CODEX_HOME?.trim() ?? '';
  const rawSqliteHome = params.processEnv.CODEX_SQLITE_HOME?.trim() ?? '';
  if (!rawCodexHome || !rawSqliteHome) return true;

  const codexHome = resolve(resolveConfiguredCodexHomePath(params.processEnv));
  const homeDir = resolveHomeDirFromEnvironment(params.processEnv);
  const runtimeHome = resolveCodexRuntimeHomeEnvironment({
    env: params.processEnv,
    codexHome,
    cwd: params.cwd,
    expandHomePath: (rawPath) => expandHomePath(rawPath, homeDir),
  });
  const sqliteHome = resolve(runtimeHome.CODEX_SQLITE_HOME);
  if (codexHome === sqliteHome) return true;

  const resolvedRolloutPath = await findCodexRolloutFileById({
    sessionsRoot: join(codexHome, 'sessions'),
    vendorResumeId,
  });
  if (!resolvedRolloutPath) return false;

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

    const indexedPath = readRolloutPath(database, vendorResumeId);
    if (!indexedPath || indexedPath === resolvedRolloutPath) return true;
    if (await isFile(indexedPath)) return true;

    database
      .prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      .run(resolvedRolloutPath, vendorResumeId, indexedPath);

    const settledPath = readRolloutPath(database, vendorResumeId);
    if (settledPath === resolvedRolloutPath) return true;
    return settledPath !== null && await isFile(settledPath);
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
