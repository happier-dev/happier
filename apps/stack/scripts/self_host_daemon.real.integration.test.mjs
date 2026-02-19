import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import nacl from 'tweetnacl';

import { commandExists, extractBinaryFromArtifact, reserveLocalhostPort, run, waitForHealth } from './self_host_service_e2e_harness.mjs';

const SELF_HOST_INSTALL_TIMEOUT_MS = 420_000;

function currentTarget() {
  if (process.platform === 'linux') {
    if (process.arch === 'x64') return 'linux-x64';
    if (process.arch === 'arm64') return 'linux-arm64';
    return '';
  }
  if (process.platform === 'darwin') {
    if (process.arch === 'x64') return 'darwin-x64';
    if (process.arch === 'arm64') return 'darwin-arm64';
    return '';
  }
  return '';
}

function deriveServerIdFromUrl(rawUrl) {
  const normalized = String(rawUrl || '').trim().replace(/\/+$/, '');
  let h = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

async function writeCredentialsForServer({ homeDir, serverUrl, token }) {
  const happyHomeDir = String(homeDir ?? '').trim();
  assert.ok(happyHomeDir, 'homeDir is required');
  const id = deriveServerIdFromUrl(serverUrl);
  const scopedDir = join(happyHomeDir, 'servers', id);
  await mkdir(scopedDir, { recursive: true });
  await mkdir(happyHomeDir, { recursive: true });

  const secret = Buffer.alloc(32, 7).toString('base64');
  const payload = `${JSON.stringify({ token, secret }, null, 2)}\n`;

  const legacyPath = join(happyHomeDir, 'access.key');
  const scopedPath = join(scopedDir, 'access.key');
  await writeFile(legacyPath, payload, { mode: 0o600 });
  await writeFile(scopedPath, payload, { mode: 0o600 });
  return { serverId: id };
}

async function createAuthToken(serverUrl) {
  const keyPair = nacl.sign.keyPair();
  const challenge = nacl.randomBytes(32);
  const signature = nacl.sign.detached(challenge, keyPair.secretKey);
  const encode64 = (bytes) => Buffer.from(bytes).toString('base64');

  const url = new URL('/v1/auth', String(serverUrl));
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: encode64(keyPair.publicKey),
      challenge: encode64(challenge),
      signature: encode64(signature),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[self-host-daemon] /v1/auth failed: ${res.status} ${res.statusText} ${text}`.trim());
  }
  const data = await res.json().catch(() => ({}));
  const token = String(data?.token ?? '').trim();
  if (!token) throw new Error('[self-host-daemon] /v1/auth response missing token');
  return token;
}

function runAsRoot(cmd, args, { cwd, env, timeoutMs = 0, allowFail = false, stdio = 'pipe' } = {}) {
  if (process.platform !== 'linux') {
    return run(cmd, args, { label: 'self-host-daemon', cwd, env, timeoutMs, allowFail, stdio });
  }
  const mergedEnv = { ...process.env, ...(env ?? {}) };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return run(cmd, args, { label: 'self-host-daemon', cwd, env: mergedEnv, timeoutMs, allowFail, stdio });
  }
  if (!commandExists('sudo')) {
    throw new Error('[self-host-daemon] sudo is required on linux system mode');
  }
  const envArgs = Object.entries(mergedEnv).map(([key, value]) => `${key}=${String(value ?? '')}`);
  return run('sudo', ['-E', 'env', ...envArgs, cmd, ...args], {
    label: 'self-host-daemon',
    cwd,
    env: process.env,
    timeoutMs,
    allowFail,
    stdio,
  });
}

test(
  'self-host server + daemon integration suite works against installed runtime',
  { timeout: 25 * 60_000 },
  async (t) => {
    const target = currentTarget();
    if (!target) {
      t.skip(`unsupported platform for daemon E2E: ${process.platform}-${process.arch}`);
      return;
    }
    if (!commandExists('bun')) {
      t.skip('bun is required to build compiled binaries');
      return;
    }
    if (process.platform === 'linux' && !commandExists('systemctl')) {
      t.skip('systemctl is required on linux self-host daemon E2E');
      return;
    }

    const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    const version = `0.0.0-daemon.${Date.now()}`;

    run(
      process.execPath,
      [
        'scripts/pipeline/release/build-hstack-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        `--targets=${target}`,
      ],
      {
        label: 'self-host-daemon',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 12 * 60_000,
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
        label: 'self-host-daemon',
        cwd: repoRoot,
        env: { ...process.env },
        timeoutMs: 12 * 60_000,
      }
    );

    const hstackArtifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-${target}.tar.gz`);
    const serverArtifact = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-${target}.tar.gz`);

    const extractedHstack = await extractBinaryFromArtifact({ label: 'self-host-daemon', artifactPath: hstackArtifact, binaryName: process.platform === 'win32' ? 'hstack.exe' : 'hstack' });
    const extractedServer = await extractBinaryFromArtifact({ label: 'self-host-daemon', artifactPath: serverArtifact, binaryName: process.platform === 'win32' ? 'happier-server.exe' : 'happier-server' });

    t.after(async () => {
      await rm(extractedHstack.extractDir, { recursive: true, force: true });
      await rm(extractedServer.extractDir, { recursive: true, force: true });
    });

    const sandboxDir = await mkdtemp(join(tmpdir(), 'happier-self-host-daemon-'));
    t.after(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    const installRoot = join(sandboxDir, 'self-host');
    const binDir = join(sandboxDir, 'bin');
    const configDir = join(sandboxDir, 'config');
    const dataDir = join(sandboxDir, 'data');
    const logDir = join(sandboxDir, 'logs');
    const cliHomeDir = join(sandboxDir, 'cli-home');
    await mkdir(binDir, { recursive: true });

    const hstackPath = join(binDir, process.platform === 'win32' ? 'hstack.exe' : 'hstack');
    await cp(extractedHstack.binaryPath, hstackPath);
    await chmod(hstackPath, 0o755).catch(() => {});

    const serviceName = `happier-server-e2e-${Date.now().toString(36).slice(-6)}`;
    const serverPort = await reserveLocalhostPort();
    const mode = process.platform === 'linux' ? 'system' : 'user';

    const serverUrl = `http://127.0.0.1:${serverPort}`;
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

    let installSucceeded = false;
    t.after(() => {
      if (!installSucceeded) return;
      runAsRoot(
        hstackPath,
        ['self-host', 'uninstall', '--channel=preview', `--mode=${mode}`, '--yes', '--purge-data', '--json'],
        {
          env: commonEnv,
          allowFail: true,
          timeoutMs: 180_000,
          stdio: 'ignore',
          cwd: sandboxDir,
        }
      );
    });

    const installResult = runAsRoot(
      hstackPath,
      ['self-host', 'install', '--channel=preview', `--mode=${mode}`, '--no-auto-update', '--non-interactive', '--without-cli', '--json'],
      {
        env: commonEnv,
        timeoutMs: SELF_HOST_INSTALL_TIMEOUT_MS,
        allowFail: true,
        cwd: sandboxDir,
      }
    );
    if ((installResult.status ?? 1) !== 0) {
      const recovered = await waitForHealth(`${serverUrl}/v1/version`, 120_000);
      if (!recovered) {
        throw new Error(
          [
            '[self-host-daemon] self-host install failed and never became healthy',
            `install status: ${String(installResult.status ?? 'null')}`,
            `install stdout:\n${String(installResult.stdout ?? '').trim()}`,
            `install stderr:\n${String(installResult.stderr ?? '').trim()}`,
          ].join('\n\n')
        );
      }
    }
    installSucceeded = true;

    const healthOk = await waitForHealth(`${serverUrl}/v1/version`, 120_000);
    assert.equal(healthOk, true, 'self-host service health endpoint did not become ready');

    const token = await createAuthToken(serverUrl);
    const { serverId } = await writeCredentialsForServer({ homeDir: cliHomeDir, serverUrl, token });

    const daemonEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_ACTIVE_SERVER_ID: serverId,
      HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: serverUrl,
      HAPPIER_PUBLIC_SERVER_URL: serverUrl,
      HAPPIER_NO_BROWSER_OPEN: '1',
      HAPPIER_NONINTERACTIVE: '1',
    };

    // The daemon suite is unix-only (signals/ps); fail closed on unsupported.
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const daemonRun = run(
        'yarn',
        ['--cwd', 'apps/cli', '-s', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'src/daemon/daemon.integration.test.ts'],
        {
          label: 'self-host-daemon',
          cwd: repoRoot,
          env: daemonEnv,
          timeoutMs: 15 * 60_000,
          allowFail: true,
          stdio: 'inherit',
        }
      );
      assert.equal(daemonRun.status, 0, 'daemon integration suite failed against self-host install');
    } else {
      t.skip(`daemon integration suite is unsupported on ${process.platform}`);
      return;
    }

    runAsRoot(
      hstackPath,
      ['self-host', 'uninstall', '--channel=preview', `--mode=${mode}`, '--yes', '--purge-data', '--json'],
      { env: commonEnv, timeoutMs: 180_000, cwd: sandboxDir }
    );
    installSucceeded = false;

    const healthAfter = await waitForHealth(`${serverUrl}/v1/version`, 10_000);
    assert.equal(healthAfter, false, 'server should not remain healthy after uninstall');
  }
);
