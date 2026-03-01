import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, copyFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:net';

import { configuration, reloadConfiguration } from '@/configuration';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { readCredentials } from '@/persistence';

type EnvSnapshot = {
  homeDir: string | undefined;
  activeServerId: string | undefined;
  serverUrl: string | undefined;
  webappUrl: string | undefined;
  publicServerUrl: string | undefined;
};

const originalEnv: EnvSnapshot = {
  homeDir: process.env.HAPPIER_HOME_DIR,
  activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
  serverUrl: process.env.HAPPIER_SERVER_URL,
  webappUrl: process.env.HAPPIER_WEBAPP_URL,
  publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
};

let isolatedHomeDir: string | null = null;
let sourceHomeDir: string | null = null;

async function copyIfExists(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

async function prepareIsolatedHome(): Promise<void> {
  const sourceHome = configuration.happyHomeDir;
  sourceHomeDir = sourceHome;
  const sourceSettingsFile = configuration.settingsFile;
  const sourceLegacyKeyFile = configuration.legacyPrivateKeyFile;
  const sourceServerKeyFile = configuration.privateKeyFile;

  const sourceServerId = configuration.activeServerId;
  const sourceServerUrl = configuration.serverUrl;
  const sourceWebappUrl = configuration.webappUrl;
  const sourcePublicServerUrl = configuration.publicServerUrl;

  const parentDir = join(sourceHome, 'tmp');
  await mkdir(parentDir, { recursive: true });
  isolatedHomeDir = await mkdtemp(join(parentDir, 'happier-daemon-opencode-cleanup-'));

  process.env.HAPPIER_HOME_DIR = isolatedHomeDir;
  process.env.HAPPIER_ACTIVE_SERVER_ID = sourceServerId;
  process.env.HAPPIER_SERVER_URL = sourceServerUrl;
  process.env.HAPPIER_WEBAPP_URL = sourceWebappUrl;
  process.env.HAPPIER_PUBLIC_SERVER_URL = sourcePublicServerUrl;
  reloadConfiguration();

  await copyIfExists(sourceSettingsFile, configuration.settingsFile);
  await copyIfExists(sourceLegacyKeyFile, configuration.legacyPrivateKeyFile);
  await copyIfExists(sourceServerKeyFile, configuration.privateKeyFile);

  // Integration test env may not have real credentials; daemon refuses to start non-interactively without them.
  // Provide a minimal dummy credential so the daemon can bring up its control server.
  const creds = await readCredentials().catch(() => null);
  if (!creds) {
    const path = configuration.activeServerId === 'cloud'
      ? configuration.legacyPrivateKeyFile
      : configuration.privateKeyFile;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ token: 'dummy', secret: 'AA==' }), { mode: 0o600 });
  }
}

async function restoreEnvAndCleanup(): Promise<void> {
  if (isolatedHomeDir) {
    const expectedPrefix = sourceHomeDir ? join(sourceHomeDir, 'tmp', 'happier-daemon-opencode-cleanup-') : null;
    const safeToDelete = expectedPrefix ? isolatedHomeDir.startsWith(expectedPrefix) : false;
    if (safeToDelete) {
      await rm(isolatedHomeDir, { recursive: true, force: true }).catch(() => {});
    }
    isolatedHomeDir = null;
  }

  if (originalEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
  else process.env.HAPPIER_HOME_DIR = originalEnv.homeDir;
  if (originalEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
  else process.env.HAPPIER_ACTIVE_SERVER_ID = originalEnv.activeServerId;
  if (originalEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
  else process.env.HAPPIER_SERVER_URL = originalEnv.serverUrl;
  if (originalEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
  else process.env.HAPPIER_WEBAPP_URL = originalEnv.webappUrl;
  if (originalEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  else process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.publicServerUrl;
  reloadConfiguration();
}

async function findDaemonLogPathBestEffort(pid: number): Promise<string | null> {
  try {
    const logsDir = configuration.logsDir;
    const entries = await readdir(logsDir, { withFileTypes: true }).catch(() => []);
    const match = entries.find((e) => e.isFile() && e.name.includes(`pid-${pid}`) && e.name.endsWith('.log'));
    return match ? join(logsDir, match.name) : null;
  } catch {
    return null;
  }
}

async function waitForDaemonLogMessage(params: { pid: number; needle: string; timeoutMs: number }): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  let lastTail = '';
  while (Date.now() < deadline) {
    const path = await findDaemonLogPathBestEffort(params.pid);
    if (path) {
      const raw = await readFile(path, 'utf8').catch(() => '');
      const tail = raw.length > 8_000 ? raw.slice(-8_000) : raw;
      lastTail = `\n[daemon log tail: ${path}]\n${tail}`;
      if (tail.includes(params.needle)) return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for daemon log message: ${params.needle}${lastTail}`);
}

async function resolveEphemeralPort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve ephemeral port')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidDeath(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`PID ${pid} did not exit within ${timeoutMs}ms`);
}

async function startFakeOpenCodeHealthServer(): Promise<{ pid: number; baseUrl: string; close: () => Promise<void> }> {
  const hostname = '127.0.0.1';
  const port = await resolveEphemeralPort(hostname);

  const script = `
    const http = require('http');
    const port = Number(process.env.PORT);
    const server = http.createServer((req, res) => {
      if (req.url === '/global/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ healthy: true, version: 'fake' }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    server.listen(port, '127.0.0.1');
    setInterval(() => {}, 1 << 30);
  `;

  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  child.unref?.();

  const pid = child.pid ?? -1;
  if (pid <= 0) throw new Error('Failed to spawn fake OpenCode health server process');

  const baseUrl = `http://${hostname}:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/global/health`).catch(() => null);
      if (res?.ok) break;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    pid,
    baseUrl,
    close: async () => {
      try {
        process.kill(-pid);
      } catch {
        try {
          process.kill(pid);
        } catch {
          // ignore
        }
      }
      await waitForPidDeath(pid, 5_000).catch(() => {});
    },
  };
}

async function startDaemonStartSync(): Promise<{ child: ReturnType<typeof spawnHappyCLI>; output: () => string }> {
  const child = spawnHappyCLI(['daemon', 'start-sync'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  return { child, output: () => output };
}

describe('daemon OpenCode managed server cleanup', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await prepareIsolatedHome();
  });

  afterAll(async () => {
    await restoreEnvAndCleanup();
  });

  it('kills the shared managed OpenCode server process on daemon shutdown', async () => {
    const fake = await startFakeOpenCodeHealthServer();
    let daemon: Awaited<ReturnType<typeof startDaemonStartSync>> | null = null;
    try {
      const statePath = join(configuration.happyHomeDir, 'opencode', 'managed-server.json');
      await mkdir(dirname(statePath), { recursive: true });
      await rm(statePath, { force: true }).catch(() => {});
      await writeFile(
        statePath,
        JSON.stringify({ baseUrl: fake.baseUrl, pid: fake.pid, startedAtMs: Date.now(), testRun: basename(configuration.happyHomeDir) }),
        'utf8',
      );

      daemon = await startDaemonStartSync();
      const startedDaemon = daemon;
      const daemonPid = startedDaemon.child.pid ?? -1;
      expect(daemonPid).toBeGreaterThan(0);
      await waitForDaemonLogMessage({
        pid: daemonPid,
        needle: '[DAEMON RUN] Daemon started successfully, waiting for shutdown request',
        timeoutMs: 30_000,
      });

      process.kill(daemonPid, 'SIGTERM');

      await waitForPidDeath(fake.pid, 10_000);
      expect(isPidAlive(fake.pid)).toBe(false);

      const daemonExitCode: number | null =
        startedDaemon.child.exitCode !== null
          ? startedDaemon.child.exitCode
          : await new Promise((resolve) => {
            startedDaemon.child.on('exit', (code) => resolve(code));
            startedDaemon.child.on('error', () => resolve(1));
          });

      startedDaemon.child.stdout?.removeAllListeners();
      startedDaemon.child.stderr?.removeAllListeners();

      if (daemonExitCode !== 0) {
        throw new Error(`daemon exited unexpectedly (exit=${daemonExitCode ?? 'null'})\n${startedDaemon.output()}`);
      }
    } finally {
      if (daemon && daemon.child.exitCode === null) {
        const pid = daemon.child.pid ?? -1;
        if (pid > 0) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // ignore
          }
          await waitForPidDeath(pid, 5_000).catch(() => {});
        }
      }
      await fake.close().catch(() => {});
    }
  });
});
