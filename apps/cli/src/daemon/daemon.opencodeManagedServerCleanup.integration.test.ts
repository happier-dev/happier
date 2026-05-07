import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:net';

import { configuration, reloadConfiguration } from '@/configuration';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { readCredentials } from '@/persistence';
import { spawnDetachedInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { prepareIsolatedDaemonTestHome, type PreparedDaemonTestHome } from './testkit/realIntegration.testkit';
import { isOpenCodeServerPidAlive } from '@/backends/opencode/server/openCodeServerProcessState';

let preparedDaemonHome: PreparedDaemonTestHome | null = null;

async function prepareIsolatedHome(): Promise<void> {
  preparedDaemonHome = await prepareIsolatedDaemonTestHome({
    prefix: 'happier-daemon-opencode-cleanup-',
    extraEnv: ({ homeDir }) => ({
      HAPPIER_OPENCODE_SERVER_STATE_PATH: join(homeDir, 'opencode', `managed-server-${process.pid}.json`),
      HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: '0',
    }),
  });

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
  await preparedDaemonHome?.restore();
  preparedDaemonHome = null;
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

  const child = spawnDetachedInlineNodeTestProcess(script, {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

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
      await waitForProcessExit(pid, { timeoutMs: 5_000 }).catch(() => false);
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

async function waitForOpenCodeServerPidExit(pid: number, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!isOpenCodeServerPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return !isOpenCodeServerPidAlive(pid);
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
      const statePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH
        ? process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH.trim()
        : join(configuration.happyHomeDir, 'opencode', 'managed-server.json');
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

      await expect(waitForOpenCodeServerPidExit(fake.pid, { timeoutMs: 10_000 })).resolves.toBe(true);
      expect(isOpenCodeServerPidAlive(fake.pid)).toBe(false);

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
          await waitForProcessExit(pid, { timeoutMs: 5_000 }).catch(() => false);
        }
      }
      await fake.close().catch(() => {});
    }
  });
});
