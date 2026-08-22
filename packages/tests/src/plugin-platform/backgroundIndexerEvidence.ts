import { join } from 'node:path';

export const BACKGROUND_INDEXER_PLUGIN_ID = 'examples.background-indexer';
export const WORKSPACE_INDEX_HEARTBEAT_PATH = '.happier/background-indexer';
export const WORKSPACE_INDEX_HEARTBEAT_DIGEST = 'background-indexer-v1';

export type WorkspaceIndexerHeartbeat = Readonly<{
  path: string;
  contentDigest: string;
  indexedAtMs: number;
}>;

/**
 * This is the external packed-test observation path, never a runtime database
 * owner. The host still derives and owns the database path at runtime.
 */
export function resolveWorkspaceIndexerDatabasePath(happyHomeDir: string): string {
  return join(
    happyHomeDir,
    'plugins',
    'plugins',
    'storage',
    BACKGROUND_INDEXER_PLUGIN_ID,
    'databases',
    'workspace-index.sqlite',
  );
}

export function assertWorkspaceIndexerHeartbeat(
  rows: readonly unknown[],
  minimumIndexedAtMs?: number,
): WorkspaceIndexerHeartbeat {
  if (rows.length !== 1) {
    throw new Error('workspace_indexer_heartbeat_requires_exactly_one_row');
  }
  const row = rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('workspace_indexer_heartbeat_row_invalid');
  }
  const record = row as Readonly<Record<string, unknown>>;
  if (record.path !== WORKSPACE_INDEX_HEARTBEAT_PATH) {
    throw new Error('workspace_indexer_heartbeat_path_invalid');
  }
  if (record.contentDigest !== WORKSPACE_INDEX_HEARTBEAT_DIGEST) {
    throw new Error('workspace_indexer_heartbeat_content_digest_invalid');
  }
  if (
    typeof record.indexedAtMs !== 'number'
    || !Number.isSafeInteger(record.indexedAtMs)
    || record.indexedAtMs <= 0
  ) {
    throw new Error('workspace_indexer_heartbeat_indexed_at_ms_invalid');
  }
  if (
    minimumIndexedAtMs !== undefined
    && (
      !Number.isSafeInteger(minimumIndexedAtMs)
      || minimumIndexedAtMs < 0
      || record.indexedAtMs <= minimumIndexedAtMs
    )
  ) {
    throw new Error('workspace_indexer_heartbeat_not_newer');
  }
  return Object.freeze({
    path: record.path,
    contentDigest: record.contentDigest,
    indexedAtMs: record.indexedAtMs,
  });
}
