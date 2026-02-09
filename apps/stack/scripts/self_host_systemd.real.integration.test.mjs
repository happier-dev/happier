import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function commandExists(cmd) {
  return spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function run(cmd, args, { cwd, env, timeoutMs = 0, allowFail = false, stdio = 'pipe' } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf-8',
    stdio,
    timeout: timeoutMs || undefined,
  });
  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (!allowFail && (timedOut || (result.status ?? 1) !== 0)) {
    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    const reason = timedOut ? 'timed out' : `exited with status ${result.status}`;
    throw new Error(`[self-host-systemd] ${cmd} ${args.join(' ')} ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return result;
}

function runAsRoot(cmd, args, { cwd, env, timeoutMs = 0, allowFail = false, stdio = 'pipe' } = {}) {
  const mergedEnv = {
    ...process.env,
    ...(env ?? {}),
  };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return run(cmd, args, { cwd, env: mergedEnv, timeoutMs, allowFail, stdio });
  }
  if (!commandExists('sudo')) {
    throw new Error('[self-host-systemd] sudo is required for systemd self-host test');
  }
  const envArgs = Object.entries(mergedEnv).map(([key, value]) => `${key}=${String(value ?? '')}`);
  return run('sudo', ['-E', 'env', ...envArgs, cmd, ...args], {
    cwd,
    env: process.env,
    timeoutMs,
    allowFail,
    stdio,
  });
}

async function extractBinaryFromArtifact({ artifactPath, binaryName }) {
  const extractDir = await mkdtemp(join(tmpdir(), 'happier-self-host-systemd-artifact-'));
  run('tar', ['-xzf', artifactPath, '-C', extractDir], { timeoutMs: 30_000 });
  const roots = await readdir(extractDir);
  assert.ok(roots.length > 0, `expected extracted root directory for ${artifactPath}`);
  return {
    extractDir,
    binaryPath: join(extractDir, roots[0], binaryName),
  };
}

async function waitForHealth(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (payload?.ok === true) {
          return true;
        }
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
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
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 8 * 60_000,
      }
    );

    const hstackArtifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-linux-x64.tar.gz`);
    const serverArtifact = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-linux-x64.tar.gz`);

    const extractedHstack = await extractBinaryFromArtifact({ artifactPath: hstackArtifact, binaryName: 'hstack' });
    const extractedServer = await extractBinaryFromArtifact({ artifactPath: serverArtifact, binaryName: 'happier-server' });

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
    const serverPort = 3900 + (process.pid % 500);
    const commonEnv = {
      PATH: process.env.PATH ?? '',
      HAPPIER_SELF_HOST_INSTALL_ROOT: installRoot,
      HAPPIER_SELF_HOST_BIN_DIR: binDir,
      HAPPIER_SELF_HOST_SERVICE_NAME: serviceName,
      HAPPIER_SELF_HOST_SERVER_BINARY: extractedServer.binaryPath,
      HAPPIER_SELF_HOST_AUTO_UPDATE: '0',
      HAPPIER_NONINTERACTIVE: '1',
      HAPPIER_WITH_CLI: '0',
      HAPPIER_SERVER_PORT: String(serverPort),
      HAPPIER_SERVER_HOST: '127.0.0.1',
    };

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

    runAsRoot(
      hstackPath,
      ['self-host', 'install', '--channel=preview', '--non-interactive', '--without-cli', '--json'],
      {
        env: commonEnv,
        timeoutMs: 240_000,
        cwd: '/tmp',
      }
    );
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
