import { existsSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { waitForHttpReady, reserveEphemeralPort } from '@/testkit/http/portUtils';
import { waitForProcessExit } from '@/testkit/process/spawn';

import {
  spawnSleepyDetachedProcess,
  spawnStoppableHttpDaemon,
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
  writeDaemonStateFixture,
} from './testkit/fakeDaemonLifecycle.testkit';
import { listDaemonStatusesForAllKnownServers, stopAllDaemonsBestEffort } from './multiDaemon';

describe('multi-daemon helpers', () => {
  it('lists daemon status per saved server profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const sleepy = spawnSleepyDetachedProcess();
      try {
        await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: 12345,
        });

        const results = await listDaemonStatusesForAllKnownServers();
        const company = results.find((r: { serverId: string }) => r.serverId === 'company');
        expect(company).toBeTruthy();
        expect(company!.daemon.running).toBe(true);
      } finally {
        await sleepy.kill();
      }
    });
  });

  it('includes env-scoped active server in --all status even when not persisted in settings', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-multi-daemon-active-env-',
        env: {
          HAPPIER_ACTIVE_SERVER_ID: 'stack_qa-agent-4__id_default',
          HAPPIER_SERVER_URL: 'http://127.0.0.1:3999',
          HAPPIER_WEBAPP_URL: 'http://happier-qa-agent-4.localhost:8085',
        },
      },
      async ({ homeDir }) => {
        await writeDaemonSettingsFixture(homeDir, {
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
          },
        });

        const sleepy = spawnSleepyDetachedProcess();
        try {
          await writeDaemonStateFixture(homeDir, 'stack_qa-agent-4__id_default', {
            pid: sleepy.pid,
            httpPort: 47777,
          });

          const results = await listDaemonStatusesForAllKnownServers();
          const active = results.find((r: { serverId: string }) => r.serverId === 'stack_qa-agent-4__id_default');
          expect(active).toBeTruthy();
          expect(active?.serverUrl).toBe('http://127.0.0.1:3999');
          expect(active?.daemon.running).toBe(true);
        } finally {
          await sleepy.kill();
        }
      },
    );
  });

  it('stops all running daemons best-effort via /stop and clears stale state', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stop-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const daemon = spawnStoppableHttpDaemon(port);
      expect(await waitForHttpReady(port, { timeoutMs: 2_000 })).toBe(true);

      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: daemon.pid,
        httpPort: port,
      });
      expect(existsSync(statePath)).toBe(true);

      try {
        await stopAllDaemonsBestEffort();

        expect(await waitForProcessExit(daemon.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(existsSync(statePath)).toBe(false);
      } finally {
        await daemon.kill();
      }
    });
  });

  it('sends stopSessions: true when requested', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-stop-sessions-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const sleepy = spawnSleepyDetachedProcess();
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: sleepy.pid,
        httpPort: port,
        controlToken: 'test-token',
      });

      const observed: Array<{ url: string; body: unknown; headers: unknown }> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
        observed.push({ url: String(url), body: init?.body, headers: init?.headers });
        try {
          process.kill(sleepy.pid, 'SIGTERM');
        } catch {
          // ignore
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      try {
        await stopAllDaemonsBestEffort({ stopSessions: true });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(observed[0]?.body ?? ''))).toEqual({ stopSessions: true });
        expect(String((observed[0]?.headers ?? ({} as any))['x-happier-daemon-token'] ?? '')).toBe('test-token');
        expect(await waitForProcessExit(sleepy.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(existsSync(statePath)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        await sleepy.kill();
      }
    });
  });

  it('falls back to default timeout when HAPPIER_DAEMON_HTTP_TIMEOUT is invalid', async () => {
    await withConfiguredDaemonTestHome(
      {
        prefix: 'happier-multi-daemon-invalid-timeout-',
        env: {
          HAPPIER_DAEMON_HTTP_TIMEOUT: 'not-a-number',
        },
      },
      async ({ homeDir }) => {
        await writeDaemonSettingsFixture(homeDir);

        const port = await reserveEphemeralPort();
        const sleepy = spawnSleepyDetachedProcess();
        const statePath = await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: port,
        });

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          try {
            process.kill(sleepy.pid, 'SIGTERM');
          } catch {
            // already exited
          }
          return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
        });

        try {
          await stopAllDaemonsBestEffort();

          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(await waitForProcessExit(sleepy.pid, { timeoutMs: 3_000 })).toBe(true);
          expect(existsSync(statePath)).toBe(false);
        } finally {
          fetchSpy.mockRestore();
          await sleepy.kill();
        }
      },
    );
  }, 15_000);
});
