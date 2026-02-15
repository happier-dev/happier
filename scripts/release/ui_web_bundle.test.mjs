import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { createUiWebReleaseArtifacts } from './lib/ui_web_bundle.mjs';

process.env.LC_ALL = 'C';
process.env.LANG = 'C';

test('createUiWebReleaseArtifacts packages dist into a deterministic ui-web tarball', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-'));
  const distDir = join(root, 'dist');
  const outDir = join(root, 'out');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><html></html>\n', 'utf8');
  await writeFile(join(distDir, 'assets', 'health.txt'), 'ok\n', 'utf8');

  const result = await createUiWebReleaseArtifacts({
    version: '1.2.3-preview.1.1',
    distDir,
    outDir,
  });

  assert.equal(result.product, 'happier-ui-web');
  assert.equal(result.version, '1.2.3-preview.1.1');
  assert.ok(result.artifacts.length === 1);
  assert.equal(result.artifacts[0].name, 'happier-ui-web-v1.2.3-preview.1.1-web-any.tar.gz');

  const list = spawnSync('tar', ['-tzf', result.artifacts[0].path], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  assert.equal(list.status, 0, `tar failed: ${String(list.stderr ?? '')}`);
  const output = String(list.stdout ?? '');
  assert.match(output, /happier-ui-web-v1\.2\.3-preview\.1\.1-web-any\/index\.html/);
  assert.match(output, /happier-ui-web-v1\.2\.3-preview\.1\.1-web-any\/assets\/health\.txt/);

  await rm(root, { recursive: true, force: true });
});

test('createUiWebReleaseArtifacts rejects dist directories missing index.html', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-web-bundle-missing-'));
  const distDir = join(root, 'dist');
  const outDir = join(root, 'out');
  await mkdir(distDir, { recursive: true });

  await assert.rejects(
    () => createUiWebReleaseArtifacts({ version: '1.2.3', distDir, outDir }),
    /index\.html/i,
  );

  await rm(root, { recursive: true, force: true });
});
