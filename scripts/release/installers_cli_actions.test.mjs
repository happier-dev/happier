import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'versions', '1.0.0'), { recursive: true });
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
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'versions', '1.0.0'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(happierPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(happierPath, 0o755);
  await writeFile(join(installDir, 'cli', 'current', 'marker.txt'), 'current', 'utf8');
  await writeFile(join(installDir, 'cli', 'versions', '1.0.0', 'marker.txt'), 'version', 'utf8');
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
  const checkPayload = spawnSync('bash', ['-lc', `test ! -d "${join(installDir, 'cli').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPayload.status, 0, 'expected versioned payload install root to be removed');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall skips service uninstall when daemon setup is explicitly disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-no-daemon-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const invocationLogPath = join(root, 'service-invocations.log');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'versions', '1.0.0'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(
    happierPath,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(invocationLogPath)}
exit 0
`,
    'utf8',
  );
  await chmod(happierPath, 0o755);
  await writeFile(join(installDir, 'cli', 'current', 'marker.txt'), 'current', 'utf8');
  await writeFile(join(installDir, 'cli', 'versions', '1.0.0', 'marker.txt'), 'version', 'utf8');
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
    HAPPIER_WITH_DAEMON: '0',
  };

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.equal(await readFile(invocationLogPath, 'utf8').catch(() => ''), '');

  const checkShim = spawnSync('bash', ['-lc', `test ! -e "${shimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkShim.status, 0, 'expected shim to be removed');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall does not deadlock when the managed install root is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-absent-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'missing-install-home');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n',
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
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_WITH_DAEMON: '0',
  };

  const res = spawnSync('bash', [installerPath, '--uninstall'], {
    env,
    encoding: 'utf8',
    timeout: 2_000,
  });
  assert.equal(
    res.status,
    0,
    `absent-root uninstall failed or deadlocked:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`,
  );
  await assert.rejects(stat(join(installDir, 'cli')), { code: 'ENOENT' });
  await assert.rejects(stat(join(outBinDir, 'happier')), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('install.sh --rollback restores the previous CLI version without network or current binary execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-rollback-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const tracePath = join(root, 'current-invocation.log');
  const cliRoot = join(installDir, 'cli');
  const currentVersion = '2.0.0';
  const previousVersion = '1.2.3';

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(cliRoot, 'versions', currentVersion), { recursive: true });
  await mkdir(join(cliRoot, 'versions', previousVersion), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --rollback" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  await writeFile(
    join(cliRoot, 'versions', currentVersion, 'happier'),
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(tracePath)}
exit 77
`,
    'utf8',
  );
  await chmod(join(cliRoot, 'versions', currentVersion, 'happier'), 0o755);
  await writeFile(
    join(cliRoot, 'versions', previousVersion, 'happier'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" = "--version" ]]; then
  echo "${previousVersion}"
  exit 0
fi
exit 0
`,
    'utf8',
  );
  await chmod(join(cliRoot, 'versions', previousVersion, 'happier'), 0o755);

  await symlink(`versions/${currentVersion}`, join(cliRoot, 'current'));
  await symlink(`versions/${previousVersion}`, join(cliRoot, 'previous'));
  await writeFile(join(cliRoot, 'current.version'), `${currentVersion}\n`, 'utf8');
  await writeFile(join(cliRoot, 'previous.version'), `${previousVersion}\n`, 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--rollback'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `rollback failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const versionRes = spawnSync(join(outBinDir, 'happier'), ['--version'], { env, encoding: 'utf8' });
  assert.equal(versionRes.status, 0, `rolled-back shim failed: ${String(versionRes.stderr ?? '')}`);
  assert.match(String(versionRes.stdout ?? ''), new RegExp(previousVersion.replaceAll('.', '[.]')));

  const currentLink = spawnSync('readlink', [join(cliRoot, 'current')], { encoding: 'utf8' });
  assert.equal(currentLink.status, 0, `expected current pointer to be a symlink: ${String(currentLink.stderr ?? '')}`);
  assert.match(String(currentLink.stdout ?? ''), /versions\/1\.2\.3/);
  assert.equal((await readFile(join(cliRoot, 'current.version'), 'utf8')).trim(), previousVersion);
  assert.equal((await readFile(join(cliRoot, 'previous.version'), 'utf8')).trim(), currentVersion);
  assert.equal(await readFile(tracePath, 'utf8').catch(() => ''), '', 'expected rollback to avoid invoking the broken current binary');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --rollback restores the original pointers and markers when publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-rollback-failure-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const cliRoot = join(installDir, 'cli');
  const currentVersion = '2.0.0';
  const previousVersion = '1.2.3';
  const lnInvocationCountPath = join(root, 'ln-invocation-count');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(cliRoot, 'versions', currentVersion), { recursive: true });
  await mkdir(join(cliRoot, 'versions', previousVersion), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  for (const version of [currentVersion, previousVersion]) {
    const binaryPath = join(cliRoot, 'versions', version, 'happier');
    await writeFile(binaryPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    await chmod(binaryPath, 0o755);
  }
  await symlink(`versions/${currentVersion}`, join(cliRoot, 'current'));
  await symlink(`versions/${previousVersion}`, join(cliRoot, 'previous'));
  await writeFile(join(cliRoot, 'current.version'), `${currentVersion}\n`, 'utf8');
  await writeFile(join(cliRoot, 'previous.version'), `${previousVersion}\n`, 'utf8');

  const lnStubPath = join(binDir, 'ln');
  await writeFile(
    lnStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
count=0
if [[ -f ${JSON.stringify(lnInvocationCountPath)} ]]; then
  count="$(cat ${JSON.stringify(lnInvocationCountPath)})"
fi
count=$((count + 1))
printf '%s\\n' "$count" > ${JSON.stringify(lnInvocationCountPath)}
if [[ "$count" = "2" ]]; then
  exit 73
fi
exec /bin/ln "$@"
`,
    'utf8',
  );
  await chmod(lnStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--rollback'], { env, encoding: 'utf8' });
  assert.notEqual(res.status, 0, 'expected injected previous-pointer publication failure');
  assert.equal((await readFile(join(cliRoot, 'current.version'), 'utf8')).trim(), currentVersion);
  assert.equal((await readFile(join(cliRoot, 'previous.version'), 'utf8')).trim(), previousVersion);
  assert.equal(
    String(spawnSync('readlink', [join(cliRoot, 'current')], { encoding: 'utf8' }).stdout ?? '').trim(),
    `versions/${currentVersion}`,
  );
  assert.equal(
    String(spawnSync('readlink', [join(cliRoot, 'previous')], { encoding: 'utf8' }).stdout ?? '').trim(),
    `versions/${previousVersion}`,
  );

  await rm(root, { recursive: true, force: true });
});

test('install.sh --rollback replaces a legacy physical current payload without leaving divergent previous state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-rollback-legacy-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const cliRoot = join(installDir, 'cli');
  const previousVersion = '1.2.3';

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(cliRoot, 'current'), { recursive: true });
  await mkdir(join(cliRoot, 'versions', previousVersion), { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await writeFile(join(cliRoot, 'current', 'happier'), 'legacy-current', 'utf8');
  const previousBinaryPath = join(cliRoot, 'versions', previousVersion, 'happier');
  await writeFile(previousBinaryPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(previousBinaryPath, 0o755);
  await symlink(`versions/${previousVersion}`, join(cliRoot, 'previous'));
  await writeFile(join(cliRoot, 'previous.version'), `${previousVersion}\n`, 'utf8');

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--rollback'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `legacy rollback failed:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);
  assert.equal(
    String(spawnSync('readlink', [join(cliRoot, 'current')], { encoding: 'utf8' }).stdout ?? '').trim(),
    `versions/${previousVersion}`,
  );
  assert.equal((await readFile(join(cliRoot, 'current.version'), 'utf8')).trim(), previousVersion);
  await assert.rejects(readFile(join(cliRoot, 'previous.version'), 'utf8'), { code: 'ENOENT' });
  assert.equal(
    spawnSync('bash', ['-lc', `test ! -e "${join(cliRoot, 'previous').replaceAll('"', '\\"')}"`]).status,
    0,
  );

  await rm(root, { recursive: true, force: true });
});

test('install.sh --rollback waits for the shared first-party payload mutation lock before reading markers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-rollback-lock-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const cliRoot = join(installDir, 'cli');
  const currentVersion = '2.0.0';
  const previousVersion = '1.2.3';
  const lockPath = `${cliRoot}.mutation.lock`;

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(cliRoot, 'versions', currentVersion), { recursive: true });
  await mkdir(join(cliRoot, 'versions', previousVersion), { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  for (const version of [currentVersion, previousVersion]) {
    const binaryPath = join(cliRoot, 'versions', version, 'happier');
    await writeFile(binaryPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
    await chmod(binaryPath, 0o755);
  }
  await symlink(`versions/${currentVersion}`, join(cliRoot, 'current'));
  await symlink(`versions/${previousVersion}`, join(cliRoot, 'previous'));
  await writeFile(join(cliRoot, 'current.version'), `${currentVersion}\n`, 'utf8');
  await writeFile(join(cliRoot, 'previous.version'), `${previousVersion}\n`, 'utf8');
  await mkdir(lockPath);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };
  const child = spawn('bash', [installerPath, '--rollback'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const exitPromise = new Promise((resolveExit) => child.once('exit', resolveExit));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  assert.equal(
    (await readFile(join(cliRoot, 'current.version'), 'utf8')).trim(),
    currentVersion,
    'rollback mutated state before the shared lock was released',
  );
  await rm(lockPath, { recursive: true, force: true });
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0, `locked rollback failed:\n${stdout.join('')}\n${stderr.join('')}`);
  assert.equal((await readFile(join(cliRoot, 'current.version'), 'utf8')).trim(), previousVersion);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall waits for the shared first-party payload mutation lock before removing payload and shim', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-lock-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const cliRoot = join(installDir, 'cli');
  const lockPath = `${cliRoot}.mutation.lock`;
  const happierPath = join(cliRoot, 'current', 'happier');
  const shimPath = join(outBinDir, 'happier');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(cliRoot, 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  await writeFile(happierPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(happierPath, 0o755);
  await symlink(happierPath, shimPath);
  await mkdir(lockPath);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n',
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
    HAPPIER_CHANNEL: 'stable',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_WITH_DAEMON: '0',
  };
  const child = spawn('bash', [installerPath, '--uninstall'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  const exitPromise = new Promise((resolveExit) => child.once('exit', resolveExit));

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
  assert.equal(
    (await stat(cliRoot)).isDirectory(),
    true,
    'uninstall removed the payload before the shared lock was released',
  );
  assert.equal(
    (await stat(shimPath)).isFile(),
    true,
    'uninstall removed the shim before the shared lock was released',
  );

  await rm(lockPath, { recursive: true, force: true });
  const exitCode = await exitPromise;
  assert.equal(exitCode, 0, `locked uninstall failed:\n${stdout.join('')}\n${stderr.join('')}`);
  await assert.rejects(stat(cliRoot), { code: 'ENOENT' });
  await assert.rejects(stat(shimPath), { code: 'ENOENT' });
  await assert.rejects(stat(lockPath), { code: 'ENOENT' });

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
  assert.match(trace, /service restart/i);

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
