import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';

import {
  WORKSPACE_INDEX_HEARTBEAT_DIGEST,
  WORKSPACE_INDEX_HEARTBEAT_PATH,
  assertWorkspaceIndexerHeartbeat,
  resolveWorkspaceIndexerDatabasePath,
} from './backgroundIndexerEvidence';

test('accepts only the exact newer Background Indexer heartbeat as lifecycle evidence', () => {
  const heartbeat = assertWorkspaceIndexerHeartbeat([{
    path: WORKSPACE_INDEX_HEARTBEAT_PATH,
    contentDigest: WORKSPACE_INDEX_HEARTBEAT_DIGEST,
    indexedAtMs: 101,
  }], 100);

  assert.deepEqual(heartbeat, {
    path: WORKSPACE_INDEX_HEARTBEAT_PATH,
    contentDigest: WORKSPACE_INDEX_HEARTBEAT_DIGEST,
    indexedAtMs: 101,
  });
  assert.throws(() => assertWorkspaceIndexerHeartbeat([{
    path: WORKSPACE_INDEX_HEARTBEAT_PATH,
    contentDigest: 'wrong-digest',
    indexedAtMs: 101,
  }]), /content_digest/u);
  assert.throws(() => assertWorkspaceIndexerHeartbeat([{
    path: WORKSPACE_INDEX_HEARTBEAT_PATH,
    contentDigest: WORKSPACE_INDEX_HEARTBEAT_DIGEST,
    indexedAtMs: 100,
  }], 100), /newer/u);
  assert.throws(() => assertWorkspaceIndexerHeartbeat([], 100), /requires_exactly_one/u);
});

test('derives the known packed-test inspection location without giving the plugin a path API', () => {
  assert.equal(
    resolveWorkspaceIndexerDatabasePath('/private/happier-home'),
    join(
      '/private/happier-home',
      'plugins',
      'plugins',
      'storage',
      'examples.background-indexer',
      'databases',
      'workspace-index.sqlite',
    ),
  );
});
