import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listVersionedBinaryEntries, pruneVersionedBinaries } from './version_retention.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-self-host-version-retention-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('listVersionedBinaryEntries returns newest-first versioned files for a binary', async (t) => {
  const root = await withTempRoot(t);
  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });

  const versionA = join(versionsDir, 'happier-server-1.0.0');
  const versionB = join(versionsDir, 'happier-server-1.1.0');
  await writeFile(versionA, 'a\n', 'utf-8');
  await writeFile(versionB, 'b\n', 'utf-8');
  await utimes(versionA, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  await utimes(versionB, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

  const entries = await listVersionedBinaryEntries({
    versionsDir,
    binaryName: 'happier-server',
  });

  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['happier-server-1.1.0', 'happier-server-1.0.0'],
  );
});

test('pruneVersionedBinaries keeps the newest retained versions and explicit protected versions', async (t) => {
  const root = await withTempRoot(t);
  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });

  const names = ['happier-server-1.0.0', 'happier-server-1.1.0', 'happier-server-1.2.0'];
  for (const [index, name] of names.entries()) {
    const path = join(versionsDir, name);
    await writeFile(path, `${name}\n`, 'utf-8');
    const when = new Date(Date.UTC(2026, index, 1));
    await utimes(path, when, when);
  }

  const result = await pruneVersionedBinaries({
    versionsDir,
    binaryName: 'happier-server',
    keepCount: 1,
    protectedVersions: ['1.0.0'],
  });

  assert.deepEqual(result.retained.map((entry) => entry.name), ['happier-server-1.2.0', 'happier-server-1.0.0']);
  assert.deepEqual(result.removed.map((entry) => entry.name), ['happier-server-1.1.0']);
  assert.deepEqual((await readdir(versionsDir)).sort(), ['happier-server-1.0.0', 'happier-server-1.2.0']);
});

test('pruneVersionedBinaries ignores unrelated files', async (t) => {
  const root = await withTempRoot(t);
  const versionsDir = join(root, 'versions');
  await mkdir(versionsDir, { recursive: true });
  await writeFile(join(versionsDir, 'happier-server-1.0.0'), 'ok\n', 'utf-8');
  await writeFile(join(versionsDir, 'happier-cli-1.0.0'), 'other\n', 'utf-8');

  const result = await pruneVersionedBinaries({
    versionsDir,
    binaryName: 'happier-server',
    keepCount: 1,
  });

  assert.deepEqual(result.removed, []);
  assert.deepEqual((await readdir(versionsDir)).sort(), ['happier-cli-1.0.0', 'happier-server-1.0.0']);
});
