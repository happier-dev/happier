import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SELF_HOST_INSTALL_TIMEOUT_MS = 420_000;

import { commandExists, extractBinaryFromArtifact, reserveLocalhostPort, run, waitForHealth } from './self_host_service_e2e_harness.mjs';

function currentTarget() {
  if (process.platform !== 'darwin') return '';
  if (process.arch === 'x64') return 'darwin-x64';
  if (process.arch === 'arm64') return 'darwin-arm64';
  return '';
}

function launchctlPrintTarget(label) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid != null ? `gui/${uid}/${label}` : label;
}

test(
  'compiled hstack self-host install/uninstall works on macOS launchd host without repo checkout',
  { timeout: 15 * 60_000 },
  async (t) => {
    if (process.platform !== 'darwin') {
      t.skip(`macos-only test (current: ${process.platform})`);
      return;
    }
    const target = currentTarget();
    if (!target) {
      t.skip(`unsupported macOS runner architecture: ${process.arch}`);
      return;
    }
    if (!commandExists('launchctl')) {
      t.skip('launchctl is required');
      return;
    }
    if (!commandExists('bun')) {
      t.skip('bun is required to build compiled binaries');
      return;
    }

    const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    const version = `0.0.0-launchd.${Date.now()}`;

    run(
      process.execPath,
      [
        'scripts/pipeline/release/build-hstack-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        `--targets=${target}`,
      ],
      {
        label: 'self-host-launchd',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 8 * 60_000,
      }
    );
    run(
      process.execPath,
      [
        'scripts/pipeline/release/build-server-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        `--targets=${target}`,
      ],
      {
        label: 'self-host-launchd',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 8 * 60_000,
      }
    );

    const hstackArtifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-${target}.tar.gz`);
    const serverArtifact = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-${target}.tar.gz`);

    const extractedHstack = await extractBinaryFromArtifact({ label: 'self-host-launchd', artifactPath: hstackArtifact, binaryName: 'hstack' });
    const extractedServer = await extractBinaryFromArtifact({ label: 'self-host-launchd', artifactPath: serverArtifact, binaryName: 'happier-server' });

    t.after(async () => {
      await rm(extractedHstack.extractDir, { recursive: true, force: true });
      await rm(extractedServer.extractDir, { recursive: true, force: true });
    });

    const sandboxDir = await mkdtemp(join(tmpdir(), 'happier-self-host-launchd-'));
    t.after(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    const installRoot = join(sandboxDir, 'self-host');
    const binDir = join(sandboxDir, 'bin');
    const configDir = join(sandboxDir, 'config');
    const dataDir = join(sandboxDir, 'data');
    const logDir = join(sandboxDir, 'logs');
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
      HAPPIER_SELF_HOST_CONFIG_DIR: configDir,
      HAPPIER_SELF_HOST_DATA_DIR: dataDir,
      HAPPIER_SELF_HOST_LOG_DIR: logDir,
      HAPPIER_SELF_HOST_SERVICE_NAME: serviceName,
      HAPPIER_SELF_HOST_SERVER_BINARY: extractedServer.binaryPath,
      HAPPIER_SELF_HOST_AUTO_UPDATE: '0',
      HAPPIER_SELF_HOST_HEALTH_TIMEOUT_MS: '240000',
      HAPPIER_NONINTERACTIVE: '1',
      HAPPIER_WITH_CLI: '0',
      HAPPIER_SERVER_PORT: String(serverPort),
      HAPPIER_SERVER_HOST: '127.0.0.1',
    };
    const serverOutLog = join(logDir, 'server.out.log');
    const serverErrLog = join(logDir, 'server.err.log');

    let installSucceeded = false;
    t.after(() => {
      if (!installSucceeded) return;
      run(
        hstackPath,
        ['self-host', 'uninstall', '--channel=preview', '--mode=user', '--yes', '--purge-data', '--json'],
        {
          env: commonEnv,
          allowFail: true,
          timeoutMs: 120_000,
          stdio: 'ignore',
          cwd: sandboxDir,
        }
      );
    });

    const installResult = run(
      hstackPath,
      ['self-host', 'install', '--channel=preview', '--mode=user', '--no-auto-update', '--non-interactive', '--without-cli', '--json'],
      {
        label: 'self-host-launchd',
        env: commonEnv,
        timeoutMs: SELF_HOST_INSTALL_TIMEOUT_MS,
        allowFail: true,
        cwd: sandboxDir,
      }
    );
    if ((installResult.status ?? 1) !== 0) {
      const recoveredHealth = await waitForHealth(`http://127.0.0.1:${serverPort}/v1/version`, 120_000);
      if (!recoveredHealth) {
        const statusResult = run(
          hstackPath,
          ['self-host', 'status', '--channel=preview', '--mode=user', '--json'],
          { label: 'self-host-launchd', env: commonEnv, allowFail: true, timeoutMs: 45_000, cwd: sandboxDir }
        );
        const launchctlList = run('launchctl', ['list'], { label: 'self-host-launchd', allowFail: true, timeoutMs: 20_000 });
        const launchctlPrint = run('launchctl', ['print', launchctlPrintTarget(serviceName)], { label: 'self-host-launchd', allowFail: true, timeoutMs: 20_000 });
        const outTail = run('tail', ['-n', '200', serverOutLog], { label: 'self-host-launchd', allowFail: true, timeoutMs: 10_000 });
        const errTail = run('tail', ['-n', '200', serverErrLog], { label: 'self-host-launchd', allowFail: true, timeoutMs: 10_000 });
        throw new Error(
          [
            '[self-host-launchd] self-host install failed and service never became healthy',
            `install status: ${String(installResult.status ?? 'null')}`,
            `install stdout:\n${String(installResult.stdout ?? '').trim()}`,
            `install stderr:\n${String(installResult.stderr ?? '').trim()}`,
            `self-host status:\n${String(statusResult.stdout ?? '').trim()}\n${String(statusResult.stderr ?? '').trim()}`,
            `launchctl list:\n${String(launchctlList.stdout ?? '').trim()}\n${String(launchctlList.stderr ?? '').trim()}`,
            `launchctl print:\n${String(launchctlPrint.stdout ?? '').trim()}\n${String(launchctlPrint.stderr ?? '').trim()}`,
            `server out tail (${serverOutLog}):\n${String(outTail.stdout ?? '').trim()}\n${String(outTail.stderr ?? '').trim()}`,
            `server err tail (${serverErrLog}):\n${String(errTail.stdout ?? '').trim()}\n${String(errTail.stderr ?? '').trim()}`,
          ].join('\n\n')
        );
      }
    }
    installSucceeded = true;

    const healthOk = await waitForHealth(`http://127.0.0.1:${serverPort}/v1/version`, 90_000);
    assert.equal(healthOk, true, 'self-host service health endpoint did not become ready');

    const status = run(
      hstackPath,
      ['self-host', 'status', '--channel=preview', '--mode=user', '--json'],
      { label: 'self-host-launchd', env: commonEnv, timeoutMs: 60_000, cwd: sandboxDir }
    );
    const statusPayload = JSON.parse(String(status.stdout ?? '').trim());
    assert.equal(statusPayload?.ok, true);
    assert.equal(statusPayload?.service?.name, serviceName);
    assert.equal(statusPayload?.service?.active, true);
    assert.equal(statusPayload?.healthy, true);

    const launchctlPrintAfter = run('launchctl', ['print', launchctlPrintTarget(serviceName)], { label: 'self-host-launchd', allowFail: true, timeoutMs: 20_000 });
    assert.equal(launchctlPrintAfter.status, 0, 'launchctl print should succeed after install');

    run(
      hstackPath,
      ['self-host', 'uninstall', '--channel=preview', '--mode=user', '--yes', '--purge-data', '--json'],
      { label: 'self-host-launchd', env: commonEnv, timeoutMs: 120_000, cwd: sandboxDir }
    );
    installSucceeded = false;

    const launchctlPrintAfterUninstall = run('launchctl', ['print', launchctlPrintTarget(serviceName)], { label: 'self-host-launchd', allowFail: true, timeoutMs: 20_000 });
    assert.notEqual(launchctlPrintAfterUninstall.status, 0, 'service should not remain registered after uninstall');
  }
);
