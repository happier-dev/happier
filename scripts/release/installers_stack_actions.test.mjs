import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh (stack) --check is read-only and reports missing install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-stack-check-missing-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  // Fail the test if --check tries to fetch anything.
  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --check" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'stack',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--check'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 1, `expected check to fail when not installed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.doesNotMatch(stdout + stderr, /Invalid HAPPIER_PRODUCT/i);
  assert.match(stdout + stderr, /not installed|missing/i);

  await rm(root, { recursive: true, force: true });
});

