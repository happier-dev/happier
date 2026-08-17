import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runPackedImportSmoke = process.env.HAPPIER_STACK_PACKED_IMPORT_SMOKE === '1';
const stackPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('installed packed Stack tarball imports daemon without a repository source fallback', {
  skip: !runPackedImportSmoke,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-stack-packed-daemon-import-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--pack-destination', root],
    { cwd: stackPackageDir, stdio: 'pipe' },
  );
  const tarballName = (await readdir(root)).find((name) => name.endsWith('.tgz'));
  assert.ok(tarballName, 'npm pack must produce the Stack tarball');
  const tarballPath = join(root, tarballName);
  const extractedRoot = join(root, 'extracted');
  await mkdir(extractedRoot, { recursive: true });
  execFileSync('tar', ['-xzf', tarballPath, '-C', extractedRoot], { stdio: 'pipe' });

  const installedPackageDir = join(root, 'node_modules', '@happier-dev', 'stack');
  await mkdir(dirname(installedPackageDir), { recursive: true });
  await rename(join(extractedRoot, 'package'), installedPackageDir);
  const daemonEntrypoint = join(installedPackageDir, 'scripts', 'daemon.mjs');
  assert.equal(
    existsSync(join(root, 'packages', 'cli-common', 'pinnedRunnerSnapshot.mjs')),
    false,
    'the packed import must not be able to use a checkout-relative cli-common source path',
  );

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', 'await import(process.argv[1]);', daemonEntrypoint],
    { encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
});
