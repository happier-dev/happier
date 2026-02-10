import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';

import { reloadConfiguration } from '@/configuration';

import { handleDaemonCliCommand } from './daemon';

function spawnStoppableHttpDaemon(port: number): { pid: number } {
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
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore', detached: true });
  child.unref();
  if (!child.pid) throw new Error('Failed to spawn http daemon');
  return { pid: child.pid };
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

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('happier daemon --all', () => {
  it('stops daemons for all saved servers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-daemon-all-'));
    let daemonPid: number | null = null;
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevTimeout = process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as any);

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = '750';
      reloadConfiguration();

      const settings = {
        schemaVersion: 5,
        onboardingCompleted: false,
        activeServerId: 'cloud',
        servers: {
          cloud: {
            id: 'cloud',
            name: 'Happier Cloud',
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
      daemonPid = pid;
      expect(await waitForHttpReady(port, 2000)).toBe(true);

      const serverDir = join(home, 'servers', 'company');
      mkdirSync(serverDir, { recursive: true });
      const statePath = join(serverDir, 'daemon.state.json');
      await writeFile(
        statePath,
        JSON.stringify({ pid, httpPort: port, startedAt: Date.now(), startedWithCliVersion: '0.0.0-test' }, null, 2),
        'utf-8',
      );
      expect(existsSync(statePath)).toBe(true);

      await expect(
        handleDaemonCliCommand({ args: ['daemon', 'stop', '--all'], rawArgv: [], terminalRuntime: null }),
      ).rejects.toThrow('process.exit(0)');

      expect(await waitForExit(pid, 3000)).toBe(true);
      daemonPid = null;
      expect(existsSync(statePath)).toBe(false);
    } finally {
      exitSpy.mockRestore();
      if (prevTimeout === undefined) delete process.env.HAPPIER_DAEMON_HTTP_TIMEOUT;
      else process.env.HAPPIER_DAEMON_HTTP_TIMEOUT = prevTimeout;
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      reloadConfiguration();
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, 'SIGKILL');
        } catch {
          // ignore: process may already be gone
        }
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});
