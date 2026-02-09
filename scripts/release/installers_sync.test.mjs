import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INSTALLER_FILENAMES, syncInstallers } from './sync-installers.mjs';

test('syncInstallers copies all installer artifacts to website public directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-sync-'));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const name of INSTALLER_FILENAMES) {
    await writeFile(join(sourceDir, name), `fixture:${name}\n`, 'utf8');
  }

  const result = await syncInstallers({
    sourceDir,
    targetDir,
    checkOnly: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.changed.length, INSTALLER_FILENAMES.length);
  for (const name of INSTALLER_FILENAMES) {
    const actual = await readFile(join(targetDir, name), 'utf8');
    assert.equal(actual, `fixture:${name}\n`);
  }
});

test('syncInstallers checkOnly mode fails when published file drifts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-check-'));
  const sourceDir = join(root, 'source');
  const targetDir = join(root, 'target');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });

  for (const name of INSTALLER_FILENAMES) {
    await writeFile(join(sourceDir, name), `expected:${name}\n`, 'utf8');
    await writeFile(join(targetDir, name), `stale:${name}\n`, 'utf8');
  }

  await assert.rejects(
    () => syncInstallers({ sourceDir, targetDir, checkOnly: true }),
    /out of sync/i
  );
});
