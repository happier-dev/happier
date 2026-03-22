import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listVersionedDirectoryIdsNewestFirst, pruneVersionedDirectories } from './version_retention.mjs';

test('pruneVersionedDirectories keeps current and previous server versions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-self-host-version-retention-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });
  for (const version of ['1.2.1', '1.2.2', '1.2.3']) {
    await writeFile(join(versionsDir, `happier-server-${version}`), version, 'utf-8');
  }

  const ordered = await listVersionedDirectoryIdsNewestFirst({
    versionsDir,
    entryPrefix: 'happier-server-',
  });
  assert.deepEqual(ordered, ['1.2.3', '1.2.2', '1.2.1']);

  const result = await pruneVersionedDirectories({
    versionsDir,
    entryPrefix: 'happier-server-',
    currentVersionId: '1.2.3',
    previousVersionId: '1.2.2',
  });

  assert.deepEqual(result.keptVersionIds, ['1.2.3', '1.2.2']);
  assert.deepEqual(result.prunedVersionIds, ['1.2.1']);
  assert.equal(existsSync(join(versionsDir, 'happier-server-1.2.1')), false);
  assert.equal(existsSync(join(versionsDir, 'happier-server-1.2.2')), true);
  assert.equal(existsSync(join(versionsDir, 'happier-server-1.2.3')), true);
});

test('pruneVersionedDirectories sorts preview ui web versions newest first and keeps two newest by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-self-host-ui-version-retention-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });
  for (const version of ['1.2.3-preview.1', '1.2.3-preview.3', '1.2.3-preview.2']) {
    const dir = join(versionsDir, `happier-ui-web-${version}`);
    await mkdir(dir, { recursive: true });
  }

  const ordered = await listVersionedDirectoryIdsNewestFirst({
    versionsDir,
    entryPrefix: 'happier-ui-web-',
  });
  assert.deepEqual(ordered, ['1.2.3-preview.3', '1.2.3-preview.2', '1.2.3-preview.1']);

  const result = await pruneVersionedDirectories({
    versionsDir,
    entryPrefix: 'happier-ui-web-',
    currentVersionId: '1.2.3-preview.3',
  });

  assert.deepEqual(result.keptVersionIds, ['1.2.3-preview.3', '1.2.3-preview.2']);
  assert.deepEqual(result.prunedVersionIds, ['1.2.3-preview.1']);
  assert.equal(existsSync(join(versionsDir, 'happier-ui-web-1.2.3-preview.1')), false);
});

test('pruneVersionedDirectories sorts local timestamp versions numerically and keeps the newest two', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-self-host-local-version-retention-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });
  for (const version of ['local-500', 'local-2000', 'local-1000']) {
    await writeFile(join(versionsDir, `happier-server-${version}`), version, 'utf-8');
  }

  const ordered = await listVersionedDirectoryIdsNewestFirst({
    versionsDir,
    entryPrefix: 'happier-server-',
  });
  assert.deepEqual(ordered, ['local-2000', 'local-1000', 'local-500']);

  const result = await pruneVersionedDirectories({
    versionsDir,
    entryPrefix: 'happier-server-',
    currentVersionId: 'local-2000',
    previousVersionId: 'local-1000',
  });

  assert.deepEqual(result.keptVersionIds, ['local-2000', 'local-1000']);
  assert.deepEqual(result.prunedVersionIds, ['local-500']);
  assert.equal(existsSync(join(versionsDir, 'happier-server-local-500')), false);
});
