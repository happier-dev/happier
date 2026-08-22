import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createV2Source,
  createV2SuccessorSource,
  installReviewOptionalSelections,
  makeCancellationObservable,
} from './runPackedBackgroundIndexer';

const BACKGROUND_INDEXER_SOURCE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../plugin-sdk/examples/background-indexer/src/index.ts',
);

async function readBackgroundIndexerSource(): Promise<string> {
  return await readFile(BACKGROUND_INDEXER_SOURCE_PATH, 'utf8');
}

function countOccurrences(source: string, fragment: string): number {
  return source.split(fragment).length - 1;
}

test('derives an update whose declared V2 fixture proves the V2 schema', async () => {
  const source = createV2Source(await readBackgroundIndexerSource());

  assert.match(source, /version: 2,/u);
  assert.match(source, /id: 'add-workspace-index-label'/u);
  assert.match(source, /ALTER TABLE workspace_documents ADD COLUMN label TEXT/u);
  assert.match(source, /id: 'workspace-index-v2'/u);
  assert.match(
    source,
    /SELECT path, content_digest, label FROM workspace_documents ORDER BY path LIMIT 1/u,
  );
});

test('uses a real local contraction to make the incumbent fixture reject before adoption', async () => {
  const v2Source = createV2Source(await readBackgroundIndexerSource());
  const incompatible = createV2SuccessorSource({
    source: v2Source,
    version: 4,
    id: 'drop-workspace-index',
    fixtureId: 'workspace-index-v4-incompatible',
    body: ["await transaction.execute('DROP TABLE workspace_documents');"],
  });

  assert.match(incompatible, /version: 4,/u);
  assert.match(incompatible, /DROP TABLE workspace_documents/u);
  assert.match(incompatible, /id: 'workspace-index-v4-incompatible'/u);
  assert.match(
    incompatible,
    /SELECT path, content_digest, label FROM workspace_documents ORDER BY path LIMIT 1/u,
  );
});

test('makes cancellation observable only by retaining the actual indexer runner', async () => {
  const source = makeCancellationObservable(await readBackgroundIndexerSource());

  assert.match(source, /const runWorkspaceIndexerCore: BackgroundServiceRunner/u);
  assert.match(source, /await runWorkspaceIndexerCore\(context\);/u);
  assert.match(source, /context\.signal\.addEventListener\('abort', settle/u);
  assert.equal(countOccurrences(source, 'INSERT INTO workspace_documents'), 1);
  assert.doesNotMatch(source, /set(?:Interval|Timeout)\(/u);
});

test('requires explicit present-user review facts before selecting no optional access', () => {
  assert.deepEqual(
    installReviewOptionalSelections({
      pluginId: 'examples.background-indexer',
      displayName: 'Background Indexer',
      version: '0.1.0',
      optionalHostAccess: [{ id: 'optional-access' }],
    }),
    [{ accessId: 'optional-access', selected: false }],
  );
  assert.throws(
    () => installReviewOptionalSelections({
      pluginId: 'wrong.plugin',
      displayName: 'Background Indexer',
      version: '0.1.0',
      optionalHostAccess: [],
    }),
    /review_facts_invalid/u,
  );
});
