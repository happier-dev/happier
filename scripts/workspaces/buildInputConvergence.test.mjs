import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { captureBuildInputFiles } from './buildInputConvergence.mjs';

async function filesystemRequests(run) {
  let requests = 0;
  // Measure real OS-boundary work, not elapsed time or internal helper calls.
  const hook = createHook({ init(_id, type) {
    if (type === 'FSREQPROMISE' || type === 'FSREQCALLBACK') requests++;
  } });
  hook.enable();
  try { await run(); return requests; }
  finally { hook.disable(); }
}

test('capturing admitted regular files costs less filesystem work than generic copying once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-capture-cost-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const paths = Array.from({ length: 30 }, (_, i) => `packages/example/src/group-${i}/index.js`);
  for (const path of paths) {
    await mkdir(dirname(join(sourceDir, path)), { recursive: true });
    await writeFile(join(sourceDir, path), 'export const value = 1;');
  }
  // Calibrate against Node's generic copy on the same filesystem/platform.
  // Capture includes both metadata passes; per-file ancestor validation must
  // not amplify its work beyond even the generic single-copy baseline.
  const genericRequests = await filesystemRequests(async () => {
    for (const path of paths) {
      const target = join(root, 'generic', path);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(sourceDir, path), target, { verbatimSymlinks: true });
    }
  });
  const captureDir = join(root, 'capture');
  const captureRequests = await filesystemRequests(() =>
    captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => paths }));
  t.diagnostic(JSON.stringify({ captureRequests, genericRequests }));
  assert.ok(captureRequests < genericRequests,
    `capture used ${captureRequests} filesystem requests; generic copy used ${genericRequests}`);
  for (const path of paths) assert.equal(await readFile(join(captureDir, path), 'utf8'), 'export const value = 1;');
});

test('capture preserves executable modes, empty directories and verbatim dangling links', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-capture-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'source');
  const captureDir = join(root, 'capture');
  await mkdir(join(sourceDir, 'empty'), { recursive: true });
  await writeFile(join(sourceDir, 'tool'), 'executable');
  await chmod(join(sourceDir, 'tool'), 0o751);
  await symlink('missing-relative-target', join(sourceDir, 'link'));
  await captureBuildInputFiles({ sourceDir, captureDir, readPaths: () => ['empty', 'tool', 'link'] });
  assert.equal(await readFile(join(captureDir, 'tool'), 'utf8'), 'executable');
  if (process.platform !== 'win32') assert.equal((await lstat(join(captureDir, 'tool'))).mode & 0o777, 0o751);
  assert.ok((await lstat(join(captureDir, 'empty'))).isDirectory());
  assert.equal(await readlink(join(captureDir, 'link')), 'missing-relative-target');
});
