import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function managedCliFixture(body) {
  return `#!/usr/bin/env bash
if [[ "$*" == 'service uninstall --help --json' ]]; then
  printf '%s\\n' '{"flags":["--install-root"]}'
  exit 0
fi
${body}
`;
}

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
  const invocationLogPath = join(root, 'service-context.log');

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
  await writeFile(happierPath, managedCliFixture(`
printf '%s\\n' "$*" "\${HAPPIER_HOME_DIR:-}" "\${HAPPIER_DAEMON_SERVICE_CHANNEL:-}" > "$HAPPIER_TEST_SERVICE_CONTEXT_LOG"
`), 'utf8');
  await chmod(happierPath, 0o755);
  await writeFile(join(installDir, 'cli', 'current', 'marker.txt'), 'current', 'utf8');
  await writeFile(join(installDir, 'cli', 'versions', '1.0.0', 'marker.txt'), 'version', 'utf8');
  const desktopOwnershipPath = join(installDir, 'cli.desktop-ownership.json');
  await writeFile(desktopOwnershipPath, '{"version":1,"createdByDesktop":true,"consumers":["dev.happier.app"]}');
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
    HAPPIER_TEST_SERVICE_CONTEXT_LOG: invocationLogPath,
  };
  delete env.HAPPIER_HOME_DIR;
  delete env.HAPPIER_WITH_DAEMON;

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.deepEqual((await readFile(invocationLogPath, 'utf8')).trimEnd().split('\n'), [
    `service uninstall --all --install-root ${join(installDir, 'cli')} --yes`, installDir, 'stable',
  ]);

  const checkBin = spawnSync('bash', ['-lc', `test ! -e "${happierPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkBin.status, 0, 'expected binary to be removed');
  const checkShim = spawnSync('bash', ['-lc', `test ! -e "${shimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkShim.status, 0, 'expected shim to be removed');
  const checkPayload = spawnSync('bash', ['-lc', `test ! -d "${join(installDir, 'cli').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPayload.status, 0, 'expected versioned payload install root to be removed');
  await assert.rejects(readFile(desktopOwnershipPath, 'utf8'), { code: 'ENOENT' });

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall preserves the installation and reports failed service removal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-uninstall-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'install');
  const stateHomeDir = join(root, 'state');
  const outBinDir = join(root, 'out-bin');
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(stateHomeDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  const invocationLogPath = join(root, 'service-context.log');
  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(happierPath, managedCliFixture(`
printf '%s\\n' "$*" "\${HAPPIER_HOME_DIR:-}" > "$HAPPIER_TEST_SERVICE_CONTEXT_LOG"
echo 'Service unregister denied' >&2
exit 23
`), 'utf8');
  await chmod(happierPath, 0o755);
  const payloadPath = join(installDir, 'cli', 'current', 'marker');
  await writeFile(payloadPath, 'installed');
  const desktopOwnershipPath = join(installDir, 'cli.desktop-ownership.json');
  const desktopOwnership = '{"version":1,"createdByDesktop":true,"consumers":["dev.happier.app"]}';
  await writeFile(desktopOwnershipPath, desktopOwnership);
  const shimPath = join(outBinDir, 'happier');
  await symlink(happierPath, shimPath);
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_HOME_DIR: stateHomeDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_TEST_SERVICE_CONTEXT_LOG: invocationLogPath,
  };
  delete env.HAPPIER_WITH_DAEMON;
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/installers/install.sh'), '--uninstall', '--purge'], {
    env, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'uninstall must fail when the service cannot be removed');
  assert.match(result.stderr, /Service unregister denied/);
  assert.equal(await readFile(payloadPath, 'utf8'), 'installed');
  assert.equal(await readFile(desktopOwnershipPath, 'utf8'), desktopOwnership);
  assert.equal(await readFile(shimPath, 'utf8'), await readFile(happierPath, 'utf8'));
  assert.deepEqual((await readFile(invocationLogPath, 'utf8')).trimEnd().split('\n'), [
    `service uninstall --all --install-root ${installDir} --yes`, stateHomeDir,
  ]);
});

test('install.sh --uninstall keeps an older CLI when installation-scoped cleanup is unsupported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-uninstall-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'install');
  const cliPath = join(installDir, 'bin', 'happier');
  const callsPath = join(root, 'calls');
  await mkdir(dirname(cliPath), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await writeFile(join(installDir, 'cli', 'current', 'marker'), 'installed');
  // Older releases accept help but may ignore unknown selectors during execution.
  await writeFile(cliPath, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HAPPIER_TEST_CLI_CALLS"
if [[ "$*" == 'service uninstall --help --json' ]]; then
  printf '%s\\n' '{"flags":["--all"]}'
fi
exit 0
`);
  await chmod(cliPath, 0o755);
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_HOME_DIR: installDir,
    HAPPIER_BIN_DIR: join(root, 'out-bin'),
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_TEST_CLI_CALLS: callsPath,
  };
  delete env.HAPPIER_WITH_DAEMON;
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/installers/install.sh'), '--uninstall'], {
    env, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'unsupported cleanup must keep the installation');
  assert.equal(await readFile(join(installDir, 'cli', 'current', 'marker'), 'utf8'), 'installed');
  assert.deepEqual((await readFile(callsPath, 'utf8')).trim().split('\n'), ['service uninstall --help --json']);
});

test('install.sh --uninstall preserves a damaged installation instead of using another CLI from PATH', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-uninstall-missing-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'install');
  const payloadPath = join(installDir, 'cli', 'current', 'marker');
  const otherCli = join(root, 'other-bin', 'happier');
  const callsPath = join(root, 'calls');
  await mkdir(dirname(payloadPath), { recursive: true });
  await mkdir(dirname(otherCli), { recursive: true });
  await writeFile(payloadPath, 'installed');
  await writeFile(otherCli, managedCliFixture('echo invoked > "$HAPPIER_TEST_CLI_CALLS"'));
  await chmod(otherCli, 0o755);
  const env = {
    ...process.env,
    HOME: join(root, 'home'),
    PATH: `${dirname(otherCli)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: join(root, 'out-bin'),
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_TEST_CLI_CALLS: callsPath,
  };
  delete env.HAPPIER_WITH_DAEMON;
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/installers/install.sh'), '--uninstall'], {
    env, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'missing managed CLI must prevent payload removal');
  assert.equal(await readFile(payloadPath, 'utf8'), 'installed');
  assert.equal(await readFile(callsPath, 'utf8').catch(() => ''), '');
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

test('install.sh --uninstall reports a payload removal failure', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-uninstall-permissions-'));
  const installDir = join(root, 'install');
  const payloadDir = join(installDir, 'cli', 'current');
  const outBinDir = join(root, 'out-bin');
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(payloadDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });
  const happierPath = join(installDir, 'bin', 'happier');
  await writeFile(happierPath, managedCliFixture('exit 0'));
  await chmod(happierPath, 0o755);
  await writeFile(join(payloadDir, 'marker'), 'installed');
  await chmod(payloadDir, 0o555);
  t.after(async () => {
    await chmod(payloadDir, 0o755);
    await rm(root, { recursive: true, force: true });
  });
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/installers/install.sh'), '--uninstall'], {
    env: {
      ...process.env,
      HOME: join(root, 'home'),
      HAPPIER_PRODUCT: 'cli',
      HAPPIER_INSTALL_DIR: installDir,
      HAPPIER_HOME_DIR: installDir,
      HAPPIER_BIN_DIR: outBinDir,
      HAPPIER_WITH_DAEMON: '0',
      HAPPIER_NONINTERACTIVE: '1',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'a remaining payload must not be reported as uninstalled');
  assert.doesNotMatch(result.stdout, /uninstalled\./);
  assert.equal(await readFile(join(payloadDir, 'marker'), 'utf8'), 'installed');
});

test('install.sh --uninstall --preview restores default happier shim when it pointed at preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-preview-default-shim-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli-preview', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  // Stable install present.
  const stableBinaryPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(stableBinaryPath, managedCliFixture('echo stable'), 'utf8');
  await chmod(stableBinaryPath, 0o755);

  // Preview install present and selected as default.
  const previewBinaryPath = join(installDir, 'cli-preview', 'current', 'happier');
  await writeFile(previewBinaryPath, managedCliFixture('echo preview'), 'utf8');
  await chmod(previewBinaryPath, 0o755);
  const defaultShimPath = join(installDir, 'bin', 'happier');
  await symlink('../cli-preview/current/happier', defaultShimPath);

  // Preview shim that should be removed by uninstall.
  const previewShimPath = join(installDir, 'bin', 'hprev');
  await writeFile(previewShimPath, managedCliFixture('exit 0'), 'utf8');
  await chmod(previewShimPath, 0o755);
  await symlink(previewShimPath, join(outBinDir, 'hprev'));

  // Stable PATH shim should stay and continue to resolve.
  await symlink(defaultShimPath, join(outBinDir, 'happier'));

  // Default release channel state created by payload promotion.
  await writeFile(
    join(installDir, 'default-cli-release-channel.json'),
    `${JSON.stringify({ releaseChannel: 'preview' })}\n`,
    'utf8',
  );

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const checkPreviewRoot = spawnSync('bash', ['-lc', `test ! -d "${join(installDir, 'cli-preview').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPreviewRoot.status, 0, 'expected preview payload install root to be removed');

  const checkPreviewShim = spawnSync('bash', ['-lc', `test ! -e "${join(outBinDir, 'hprev').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPreviewShim.status, 0, 'expected preview shim to be removed');

  const resolvedDefaultShim = spawnSync('bash', ['-lc', `readlink "${defaultShimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(resolvedDefaultShim.status, 0, 'expected default shim to remain a symlink');
  assert.match(String(resolvedDefaultShim.stdout ?? ''), /cli\/current\/happier/, 'expected happier shim to point back at stable after uninstalling preview');
  assert.doesNotMatch(String(resolvedDefaultShim.stdout ?? ''), /cli-preview/, 'expected happier shim to stop pointing at preview');

  const stateRaw = await readFile(join(installDir, 'default-cli-release-channel.json'), 'utf8');
  assert.equal(JSON.parse(stateRaw).releaseChannel, 'stable', 'expected default release-channel state to be reset to stable');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall keeps the fallback executable when PATH uses the managed bin directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-shared-bin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installDir = join(root, 'install');
  const binDir = join(installDir, 'bin');
  await mkdir(binDir, { recursive: true });
  for (const [channelRoot, version] of [['cli', 'stable'], ['cli-preview', 'preview']]) {
    const payloadDir = join(installDir, channelRoot, 'current');
    await mkdir(payloadDir, { recursive: true });
    const binary = join(payloadDir, 'happier');
    await writeFile(binary, managedCliFixture(`echo ${version}`));
    await chmod(binary, 0o755);
  }
  await symlink('../cli-preview/current/happier', join(binDir, 'happier'));
  await symlink('../cli-preview/current/happier', join(binDir, 'hprev'));
  await writeFile(join(installDir, 'default-cli-release-channel.json'), JSON.stringify({ releaseChannel: 'preview' }));
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/installers/install.sh'), '--uninstall'], {
    env: { ...process.env, HAPPIER_INSTALL_DIR: installDir, HAPPIER_BIN_DIR: binDir, HAPPIER_CHANNEL: 'preview', HAPPIER_PRODUCT: 'cli', HAPPIER_NONINTERACTIVE: '1' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const fallback = spawnSync(join(binDir, 'happier'), ['--version'], { encoding: 'utf8' });
  assert.equal(fallback.status, 0, fallback.error?.message || fallback.stderr);
  assert.equal(fallback.stdout.trim(), 'stable');
});

test('install.sh --uninstall (stable) preserves default happier shim when it points at preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-stable-preserve-default-shim-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli-preview', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const stableBinaryPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(stableBinaryPath, managedCliFixture('echo stable'), 'utf8');
  await chmod(stableBinaryPath, 0o755);

  const previewBinaryPath = join(installDir, 'cli-preview', 'current', 'happier');
  await writeFile(previewBinaryPath, managedCliFixture('echo preview'), 'utf8');
  await chmod(previewBinaryPath, 0o755);

  const defaultShimPath = join(installDir, 'bin', 'happier');
  await symlink('../cli-preview/current/happier', defaultShimPath);
  await symlink(defaultShimPath, join(outBinDir, 'happier'));

  await writeFile(
    join(installDir, 'default-cli-release-channel.json'),
    `${JSON.stringify({ releaseChannel: 'preview' })}\n`,
    'utf8',
  );

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

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const checkStableRoot = spawnSync('bash', ['-lc', `test ! -d "${join(installDir, 'cli').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkStableRoot.status, 0, 'expected stable payload install root to be removed');

  const checkPreviewRoot = spawnSync('bash', ['-lc', `test -d "${join(installDir, 'cli-preview').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPreviewRoot.status, 0, 'expected preview payload install root to remain');

  const checkOutShim = spawnSync('bash', ['-lc', `test -e "${join(outBinDir, 'happier').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkOutShim.status, 0, 'expected PATH shim to remain');

  const resolvedDefaultShim = spawnSync('bash', ['-lc', `readlink "${defaultShimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(resolvedDefaultShim.status, 0, 'expected default shim to remain a symlink');
  assert.match(String(resolvedDefaultShim.stdout ?? ''), /cli-preview\/current\/happier/, 'expected happier shim to keep pointing at preview');

  const stateRaw = await readFile(join(installDir, 'default-cli-release-channel.json'), 'utf8');
  assert.equal(JSON.parse(stateRaw).releaseChannel, 'preview', 'expected default release-channel state to remain preview');

  await rm(root, { recursive: true, force: true });
});

test('install.sh --uninstall (stable) switches default happier shim to preview when stable was default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-uninstall-stable-switch-default-shim-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'bin'), { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(join(installDir, 'cli-preview', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho "curl should not run in --uninstall" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const stableBinaryPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(stableBinaryPath, managedCliFixture('echo stable'), 'utf8');
  await chmod(stableBinaryPath, 0o755);

  const previewBinaryPath = join(installDir, 'cli-preview', 'current', 'happier');
  await writeFile(previewBinaryPath, managedCliFixture('echo preview'), 'utf8');
  await chmod(previewBinaryPath, 0o755);

  const defaultShimPath = join(installDir, 'bin', 'happier');
  await symlink('../cli/current/happier', defaultShimPath);
  await symlink(defaultShimPath, join(outBinDir, 'happier'));

  await writeFile(
    join(installDir, 'default-cli-release-channel.json'),
    `${JSON.stringify({ releaseChannel: 'stable' })}\n`,
    'utf8',
  );

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

  const res = spawnSync('bash', [installerPath, '--uninstall'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const checkStableRoot = spawnSync('bash', ['-lc', `test ! -d "${join(installDir, 'cli').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkStableRoot.status, 0, 'expected stable payload install root to be removed');

  const checkPreviewRoot = spawnSync('bash', ['-lc', `test -d "${join(installDir, 'cli-preview').replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(checkPreviewRoot.status, 0, 'expected preview payload install root to remain');

  const resolvedDefaultShim = spawnSync('bash', ['-lc', `readlink "${defaultShimPath.replaceAll('"', '\\"')}"`], { encoding: 'utf8' });
  assert.equal(resolvedDefaultShim.status, 0, 'expected default shim to remain a symlink');
  assert.match(String(resolvedDefaultShim.stdout ?? ''), /cli-preview\/current\/happier/, 'expected happier shim to point at preview after uninstalling stable');

  const stateRaw = await readFile(join(installDir, 'default-cli-release-channel.json'), 'utf8');
  assert.equal(JSON.parse(stateRaw).releaseChannel, 'preview', 'expected default release-channel state to fall back to preview');

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
  await writeFile(happierPath, managedCliFixture('exit 0'), 'utf8');
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
    { "name": "happier-v9.9.9-linux-x64.tar.gz", "browser_download_url": "https://example.invalid/happier-v9.9.9-linux-x64.tar.gz" },
    { "name": "checksums-happier-v9.9.9.txt", "browser_download_url": "https://example.invalid/checksums-happier-v9.9.9.txt" }
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
