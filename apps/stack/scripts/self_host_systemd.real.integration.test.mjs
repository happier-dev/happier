import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SELF_HOST_INSTALL_TIMEOUT_MS = 420_000;

import { commandExists, extractBinaryFromArtifact, reserveLocalhostPort, run, waitForHealth } from './self_host_service_e2e_harness.mjs';

function runAsRoot(cmd, args, { cwd, env, timeoutMs = 0, allowFail = false, stdio = 'pipe' } = {}) {
  const mergedEnv = {
    ...process.env,
    ...(env ?? {}),
  };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return run(cmd, args, { label: 'self-host-systemd', cwd, env: mergedEnv, timeoutMs, allowFail, stdio });
  }
  if (!commandExists('sudo')) {
    throw new Error('[self-host-systemd] sudo is required for systemd self-host test');
  }
  const envArgs = Object.entries(mergedEnv).map(([key, value]) => `${key}=${String(value ?? '')}`);
  return run('sudo', ['-E', 'env', ...envArgs, cmd, ...args], {
    label: 'self-host-systemd',
    cwd,
    env: process.env,
    timeoutMs,
    allowFail,
    stdio,
  });
}

test(
  'compiled hstack self-host install/uninstall works on systemd host without repo checkout',
  { timeout: 15 * 60_000 },
  async (t) => {
    if (process.platform !== 'linux') {
      t.skip(`linux-only test (current: ${process.platform})`);
      return;
    }
    if (process.arch !== 'x64') {
      t.skip(`linux-x64 runner required (current: ${process.arch})`);
      return;
    }
    if (!commandExists('systemctl')) {
      t.skip('systemctl is required');
      return;
    }
    if (!commandExists('bun')) {
      t.skip('bun is required to build compiled binaries');
      return;
    }
    if (typeof process.getuid === 'function' && process.getuid() !== 0 && !commandExists('sudo')) {
      t.skip('sudo/root access is required');
      return;
    }

    const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    const version = `0.0.0-systemd.${Date.now()}`;

    run(
      process.execPath,
      [
        'scripts/release/build-hstack-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        '--targets=linux-x64',
      ],
      {
        label: 'self-host-systemd',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 8 * 60_000,
      }
    );
    run(
      process.execPath,
      [
        'scripts/release/build-server-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        '--targets=linux-x64',
      ],
      {
        label: 'self-host-systemd',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 8 * 60_000,
      }
    );

    const hstackArtifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-linux-x64.tar.gz`);
    const serverArtifact = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-linux-x64.tar.gz`);

    const extractedHstack = await extractBinaryFromArtifact({ label: 'self-host-systemd', artifactPath: hstackArtifact, binaryName: 'hstack' });
    const extractedServer = await extractBinaryFromArtifact({ label: 'self-host-systemd', artifactPath: serverArtifact, binaryName: 'happier-server' });

    t.after(async () => {
      await rm(extractedHstack.extractDir, { recursive: true, force: true });
      await rm(extractedServer.extractDir, { recursive: true, force: true });
    });

    const sandboxDir = await mkdtemp(join(tmpdir(), 'happier-self-host-systemd-'));
    t.after(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    const installRoot = join(sandboxDir, 'opt-happier');
    const binDir = join(sandboxDir, 'bin');
    await mkdir(binDir, { recursive: true });

    const hstackPath = join(binDir, 'hstack');
    await cp(extractedHstack.binaryPath, hstackPath);
    await chmod(hstackPath, 0o755);

    const serviceName = `happier-server-e2e-${Date.now().toString(36).slice(-6)}`;
    const serverPort = await reserveLocalhostPort();
    const commonEnv = {
      PATH: process.env.PATH ?? '',
      HAPPIER_SELF_HOST_INSTALL_ROOT: installRoot,
      HAPPIER_SELF_HOST_BIN_DIR: binDir,
      HAPPIER_SELF_HOST_SERVICE_NAME: serviceName,
      HAPPIER_SELF_HOST_SERVER_BINARY: extractedServer.binaryPath,
      HAPPIER_SELF_HOST_AUTO_UPDATE: '0',
      HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS: '240000',
      HAPPIER_NONINTERACTIVE: '1',
      HAPPIER_WITH_CLI: '0',
      HAPPIER_SERVER_PORT: String(serverPort),
      HAPPIER_SERVER_HOST: '127.0.0.1',
    };
    const configDir = String(commonEnv.HAPPIER_SELF_HOST_CONFIG_DIR ?? '/etc/happier');
    const logDir = String(commonEnv.HAPPIER_SELF_HOST_LOG_DIR ?? '/var/log/happier');
    const serverEnvPath = join(configDir, 'server.env');
    const serverLogPath = join(logDir, 'server.log');

    let installSucceeded = false;
    t.after(() => {
      if (!installSucceeded) return;
      runAsRoot(
        hstackPath,
        ['self-host', 'uninstall', '--channel=preview', '--yes', '--purge-data', '--json'],
        {
          env: commonEnv,
          allowFail: true,
          timeoutMs: 120_000,
          stdio: 'ignore',
          cwd: '/tmp',
        }
      );
    });

    const installResult = runAsRoot(
      hstackPath,
      ['self-host', 'install', '--channel=preview', '--non-interactive', '--without-cli', '--json'],
      {
        env: commonEnv,
        timeoutMs: SELF_HOST_INSTALL_TIMEOUT_MS,
        allowFail: true,
        cwd: '/tmp',
      }
    );
    if ((installResult.status ?? 1) !== 0) {
      const recoveredHealth = await waitForHealth(`http://127.0.0.1:${serverPort}/v1/version`, 120_000);
      if (!recoveredHealth) {
        const statusResult = runAsRoot(
          'systemctl',
          ['status', `${serviceName}.service`, '--no-pager', '--full'],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        const journalResult = runAsRoot(
          'journalctl',
          ['-u', `${serviceName}.service`, '-n', '200', '--no-pager'],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        const unitResult = runAsRoot(
          'systemctl',
          ['cat', `${serviceName}.service`],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        const envFileResult = runAsRoot(
          'cat',
          [serverEnvPath],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        const logDirResult = runAsRoot(
          'ls',
          ['-la', logDir],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        const serverLogResult = runAsRoot(
          'tail',
          ['-n', '300', serverLogPath],
          {
            env: commonEnv,
            allowFail: true,
            timeoutMs: 30_000,
            cwd: '/tmp',
          }
        );
        throw new Error(
          [
            '[self-host-systemd] self-host install failed and service never became healthy',
            `install status: ${String(installResult.status ?? 'null')}`,
            `install stdout:\n${String(installResult.stdout ?? '').trim()}`,
            `install stderr:\n${String(installResult.stderr ?? '').trim()}`,
            `systemctl status:\n${String(statusResult.stdout ?? '').trim()}\n${String(statusResult.stderr ?? '').trim()}`,
            `journalctl tail:\n${String(journalResult.stdout ?? '').trim()}\n${String(journalResult.stderr ?? '').trim()}`,
            `systemctl cat:\n${String(unitResult.stdout ?? '').trim()}\n${String(unitResult.stderr ?? '').trim()}`,
            `server env (${serverEnvPath}):\n${String(envFileResult.stdout ?? '').trim()}\n${String(envFileResult.stderr ?? '').trim()}`,
            `log dir (${logDir}):\n${String(logDirResult.stdout ?? '').trim()}\n${String(logDirResult.stderr ?? '').trim()}`,
            `server log tail (${serverLogPath}):\n${String(serverLogResult.stdout ?? '').trim()}\n${String(serverLogResult.stderr ?? '').trim()}`,
          ].join('\n\n')
        );
      }
    }
    installSucceeded = true;

    const healthOk = await waitForHealth(`http://127.0.0.1:${serverPort}/v1/version`, 90_000);
    assert.equal(healthOk, true, 'self-host service health endpoint did not become ready');

    const status = runAsRoot(
      hstackPath,
      ['self-host', 'status', '--channel=preview', '--json'],
      {
        env: commonEnv,
        timeoutMs: 60_000,
        cwd: '/tmp',
      }
    );
    const statusPayload = JSON.parse(String(status.stdout ?? '').trim());
    assert.equal(statusPayload?.ok, true);
    assert.equal(statusPayload?.service?.name, `${serviceName}.service`);
    assert.equal(statusPayload?.service?.active, true);
    assert.equal(statusPayload?.healthy, true);

    runAsRoot('systemctl', ['is-active', '--quiet', `${serviceName}.service`], {
      env: commonEnv,
      timeoutMs: 30_000,
      cwd: '/tmp',
      stdio: 'ignore',
    });

    runAsRoot(
      hstackPath,
      ['self-host', 'uninstall', '--channel=preview', '--yes', '--purge-data', '--json'],
      {
        env: commonEnv,
        timeoutMs: 120_000,
        cwd: '/tmp',
      }
    );
    installSucceeded = false;

    const activeAfterUninstall = runAsRoot('systemctl', ['is-active', '--quiet', `${serviceName}.service`], {
      env: commonEnv,
      allowFail: true,
      timeoutMs: 30_000,
      cwd: '/tmp',
      stdio: 'ignore',
    });
    assert.notEqual(activeAfterUninstall.status, 0, 'service should be inactive after uninstall');
  }
);
