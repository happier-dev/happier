import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { reloadConfiguration } from '@/configuration';

import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from './multiDaemon';

function spawnSleepyProcess(): { child: ReturnType<typeof spawn>; pid: number } {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error('Failed to spawn test process');
  return { child, pid: child.pid };
}

function spawnStoppableHttpDaemon(port: number): { child: ReturnType<typeof spawn>; pid: number } {
  const code = `
    const http = require('http');
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/stop') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => process.exit(0), 10);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(${port}, '127.0.0.1');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', code], {
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error('Failed to spawn http daemon');
  return { child, pid: child.pid };
}

async function reserveEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      // still alive
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function waitForHttpReady(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(250) });
      if (res.status === 404 || res.status === 200) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('multi-daemon helpers', () => {
  it('lists daemon status per saved server profile', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-multi-daemon-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    let pid: number | null = null;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const settings = {
        schemaVersion: 5,
        onboardingCompleted: false,
        activeServerId: 'official',
        servers: {
          official: {
            id: 'official',
            name: 'Official',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
          company: {
            id: 'company',
            name: 'Company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
        machineIdByServerId: {},
        machineIdConfirmedByServerByServerId: {},
        lastChangesCursorByServerIdByAccountId: {},
      };
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

      pid = spawnSleepyProcess().pid;
      const serverDir = join(home, 'servers', 'company');
      mkdirSync(serverDir, { recursive: true });
      await writeFile(
        join(serverDir, 'daemon.state.json'),
        JSON.stringify(
          {
            pid,
            httpPort: 12345,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const results = await listDaemonStatusesForAllKnownServers();
      const company = results.find((r: { serverId: string }) => r.serverId === 'company');
      expect(company).toBeTruthy();
      expect(company!.daemon.running).toBe(true);

    } finally {
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already exited
        }
        await waitForExit(pid, 2000);
      }
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stops all running daemons best-effort via /stop and clears stale state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-multi-daemon-stop-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      reloadConfiguration();

      const settings = {
        schemaVersion: 5,
        onboardingCompleted: false,
        activeServerId: 'official',
        servers: {
          official: {
            id: 'official',
            name: 'Official',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
          company: {
            id: 'company',
            name: 'Company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
        machineIdByServerId: {},
        machineIdConfirmedByServerByServerId: {},
        lastChangesCursorByServerIdByAccountId: {},
      };
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

      const port = await reserveEphemeralPort();
      const { pid } = spawnStoppableHttpDaemon(port);
      expect(await waitForHttpReady(port, 2000)).toBe(true);
      const serverDir = join(home, 'servers', 'company');
      mkdirSync(serverDir, { recursive: true });
      const statePath = join(serverDir, 'daemon.state.json');
      await writeFile(
        statePath,
        JSON.stringify(
          {
            pid,
            httpPort: port,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
          },
          null,
          2,
        ),
        'utf-8',
      );
      expect(existsSync(statePath)).toBe(true);

      await stopAllDaemonsBestEffort();

      expect(await waitForExit(pid, 3000)).toBe(true);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to default timeout when HAPPIER_DAEMON_HTTP_TIMEOUT is invalid', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-multi-daemon-invalid-timeout-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    let pid: number | null = null;
    let fetchSpy: any = null;
    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = 'not-a-number';
      reloadConfiguration();

      const settings = {
        schemaVersion: 5,
        onboardingCompleted: false,
        activeServerId: 'official',
        servers: {
          official: {
            id: 'official',
            name: 'Official',
            serverUrl: 'https://api.happier.dev',
            webappUrl: 'https://app.happier.dev',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
          company: {
            id: 'company',
            name: 'Company',
            serverUrl: 'https://company.example.test',
            webappUrl: 'https://company.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
          },
        },
        machineIdByServerId: {},
        machineIdConfirmedByServerByServerId: {},
        lastChangesCursorByServerIdByAccountId: {},
      };
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

      const port = await reserveEphemeralPort();
      const sleepy = spawnSleepyProcess();
      pid = sleepy.pid;
      const serverDir = join(home, 'servers', 'company');
      mkdirSync(serverDir, { recursive: true });
      const statePath = join(serverDir, 'daemon.state.json');
      await writeFile(
        statePath,
        JSON.stringify(
          {
            pid,
            httpPort: port,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
          },
          null,
          2,
        ),
        'utf-8',
      );

      fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        if (pid !== null) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already exited
          }
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      await stopAllDaemonsBestEffort();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await waitForExit(pid, 3000)).toBe(true);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      fetchSpy?.mockRestore();
      if (pid !== null) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      if (prevTimeout === undefined) delete process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
      else process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = prevTimeout;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
