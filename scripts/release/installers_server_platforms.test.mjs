import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh (server) no longer gates darwin as Linux-only before fetching metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-server-version-darwin-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Darwin
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo arm64
  exit 0
fi
echo Darwin
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "__curl_called__" >&2
exit 88
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'server',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--reinstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.notEqual(res.status, 0, `expected reinstall to fail due to curl stub:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /__curl_called__/);
  assert.doesNotMatch(stdout + stderr, /published for Linux only/i);

  await rm(root, { recursive: true, force: true });
});
