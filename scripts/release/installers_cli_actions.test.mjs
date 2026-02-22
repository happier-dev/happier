import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh --check is read-only and reports missing install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-check-missing-'));
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
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--check'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 1, `expected check to fail when not installed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /not installed|missing/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --check reports installed binary and shim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-check-ok-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --check" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(
    happierPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--version" ]]; then
  echo "9.9.9"
  exit 0
fi
exit 0
`,
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const shimPath = join(outBinDir, 'happier');
  await symlink(happierPath, shimPath);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--check'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `check failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /happier/i);
  assert.match(stdout, /9\.9\.9/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall removes installed binary and shim without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(happierPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(happierPath, 0o755);
  const shimPath = join(outBinDir, 'happier');
  await symlink(happierPath, shimPath);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const checkBin = spawnSync('bash', ['-lc', `test ! -e "${happierPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkBin.status, 0, 'expected binary to be removed');
  const checkShim = spawnSync('bash', ['-lc', `test ! -e "${shimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkShim.status, 0, 'expected shim to be removed');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --reset purges the install directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-reset-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --reset" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(happierPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(happierPath, 0o755);
  const shimPath = join(outBinDir, 'happier');
  await symlink(happierPath, shimPath);

  // Extra marker file to ensure purge removes the whole install directory.
  await writeFile(join(installDir, 'marker.txt'), 'x', 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--reset'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `reset failed:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);

  const checkInstallDir = spawnSync('bash', ['-lc', `test ! -d "${installDir.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkInstallDir.status, 0, 'expected install dir to be removed');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --restart restarts the CLI daemon without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-restart-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --restart" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const tracePath = join(root, 'trace.txt');
  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(
    happierPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(tracePath)}
exit 0
`,
    'utf8',
  );
  await chmod(happierPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--restart'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `restart failed:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /daemon service restart/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --reinstall is accepted and runs the install flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-reinstall-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    '#!/usr/bin/env bash\n\necho "curl invoked" >&2\nexit 88\n',
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--reinstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 1, `expected reinstall to enter install flow and attempt fetching releases:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.doesNotMatch(stdout + stderr, /unknown argument/i);
  assert.match(stdout + stderr, /fetching .* release metadata/i);
  assert.match(stdout + stderr, /curl invoked/i);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --version prints release version without installing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-version-'));
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
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *" -o "* ]]; then
  echo "curl should not download assets in --version" >&2
  exit 99
fi
cat <<'JSON'
{
  "assets": [
    { "name": "happier-v9.9.9-linux-x64.tar.gz", "browser_download_url": "https://example.invalid/happier-v9.9.9-linux-x64.tar.gz" }
  ]
}
JSON
exit 0
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
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--version'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `version failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /\b9\.9\.9\b/);
  assert.doesNotMatch(stdout + stderr, /Added .* to PATH/i);

  await rm(root, { recursive: true, force: true });
});
