import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh defaults to stable channel when HAPPIER_CHANNEL is unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-default-channel-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  delete env.HAPPIER_CHANNEL;

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  assert.notEqual(res.status, 0);
  assert.match(stdout, /Fetching cli-stable release metadata/i);
  assert.doesNotMatch(stdout, /Fetching cli-preview release metadata/i);
});

test('install.sh supports --channel preview when HAPPIER_CHANNEL is unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-flag-channel-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  delete env.HAPPIER_CHANNEL;

  const res = spawnSync('bash', [installerPath, '--channel', 'preview'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  assert.notEqual(res.status, 0);
  assert.match(stdout, /Fetching cli-preview release metadata/i);
  assert.doesNotMatch(stdout, /Fetching cli-stable release metadata/i);
});

test('install.sh prints a stable-channel missing message when stable tag is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-stable-missing-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
exit 22
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };
  delete env.HAPPIER_CHANNEL;

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  const stderr = String(res.stderr ?? '');
  assert.match(stderr, /No stable releases/i);
});

test('install.sh prints a helpful error when --channel is missing a value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-missing-channel-value-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
  };
  delete env.HAPPIER_CHANNEL;

  const res = spawnSync('bash', [installerPath, '--channel'], { env, encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  const stderr = String(res.stderr ?? '');
  assert.match(stderr, /Missing value for --channel/i);
});
