import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  openSqliteDatabaseSync,
  type SqliteDatabaseSync,
} from '@happier-dev/plugin-sdk/fs';

import { findCodexRolloutFileById, isMatchingCodexRolloutFileName } from '../../../../rollout/discovery/sessionFileSearch.js';
import { isMatchingCodexRolloutIdentity, readCodexSessionMetaFromRollout, resolveCodexLogicalRolloutPath, resolveExistingCodexRolloutPath } from '../../../../rollout/discovery/indexData.js';
import { readExactCodexVendorResumeId } from '../../home/sync/sessionFiles.js';
import { readExactCodexProviderSessionId } from '../../../../../protocol/runtimeDescriptorV1.js';
import { resolveCodexRuntimeStore, type CodexRuntimeStore } from './files.js';

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
    ? rolloutPath
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

async function findVerifiedMovedRollout(codexHome: string, indexedPath: string, vendorResumeId: string): Promise<string | null> {
  const recordedName = indexedPath.split(/[\\/]/u).pop() ?? '';
  if (!isMatchingCodexRolloutFileName(recordedName, vendorResumeId)) return null;
  const path = await findCodexRolloutFileById({
    sessionsRoot: join(codexHome, 'sessions'), vendorResumeId,
    recordedFileName: resolveCodexLogicalRolloutPath(recordedName),
  });
  if (!path) return null;
  const metadata = await readCodexSessionMetaFromRollout(path);
  return isMatchingCodexRolloutIdentity(readExactCodexProviderSessionId(metadata?.id) ?? undefined, vendorResumeId)
    ? path : null;
}

/** Observes native resume authority without creating or repairing its index. */
export async function resolveExistingCodexIndexedRolloutPath(params: Readonly<{
  store: CodexRuntimeStore;
  vendorResumeId: string;
  signal: AbortSignal;
  allowMovedRollout?: boolean;
}>): Promise<string | null> {
  params.signal.throwIfAborted();
  const vendorResumeId = readExactCodexProviderSessionId(params.vendorResumeId);
  if (!vendorResumeId) return null;
  if (!params.store.sqliteHome) return null;
  const databasePath = join(params.store.sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
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
    const rolloutPath = await resolveExistingCodexRolloutPath(indexedPath) ?? (params.allowMovedRollout
      ? await findVerifiedMovedRollout(params.store.environment.CODEX_HOME, indexedPath, vendorResumeId)
      : null);
    params.signal.throwIfAborted();
    return rolloutPath;
  } finally {
    database.close();
  }
}

/**
 * Repairs the one Codex-native index field needed by `thread/resume` or
 * `thread/fork` after the exact rollout has moved to this Codex home.
 *
 * The Codex plugin owns both the provider schema and this provider-operation
 * boundary. This is intentionally not a reindexer: it never creates a database,
 * table, or thread row, and it updates only a missing path through an exact
 * compare-and-set so a concurrent Codex write wins.
 */
export async function reconcileCodexResumeRolloutPath(params: Readonly<{
  vendorResumeId: string;
}> & ({ store: CodexRuntimeStore } | { processEnv: Readonly<Record<string, string | undefined>>; cwd: string })): Promise<boolean> {
  const vendorResumeId = readExactCodexVendorResumeId(params.vendorResumeId);
  if (!vendorResumeId) return false;

  const store = 'store' in params ? params.store
    : await resolveCodexRuntimeStore({ env: params.processEnv, cwd: params.cwd });
  if (!store.sqliteHome) return false;

  const databasePath = join(store.sqliteHome, CODEX_STATE_DATABASE_FILE_NAME);
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
    if (!indexedPath) return true;
    if (await resolveExistingCodexRolloutPath(indexedPath)) return true;

    // A revert can leave several same-thread rollouts. Only the recorded
    // physical basename (canonicalized for compression) identifies this row's continuation.
    const resolvedRolloutPath = await findVerifiedMovedRollout(store.environment.CODEX_HOME, indexedPath, vendorResumeId);
    if (!resolvedRolloutPath) return false;
    const logicalRolloutPath = resolveCodexLogicalRolloutPath(resolvedRolloutPath);

    database
      .prepare('UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?')
      .run(logicalRolloutPath, vendorResumeId, indexedPath);

    const settledPath = readRolloutPath(database, vendorResumeId);
    return settledPath !== null && await resolveExistingCodexRolloutPath(settledPath) !== null;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
