import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';
import { buildLaunchdPlistXml, renderSystemdServiceUnit, renderWindowsScheduledTaskWrapperPs1 } from '@happier-dev/cli-common/service';

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
import { resolveDaemonServiceCliRuntimeFromEnv, resolveDaemonServicePaths } from './service/cli';

function writeValidInstalledDaemonServiceForCurrentRuntime(homeDir: string, serverId: string): void {
  const runtimeProcessEnv = {
    ...process.env,
    HAPPIER_DAEMON_SERVICE_INSTANCE_ID: serverId,
    HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
  };
  const runtime = resolveDaemonServiceCliRuntimeFromEnv({ processEnv: runtimeProcessEnv });
  const paths = resolveDaemonServicePaths(runtime);

  mkdirSync(dirname(paths.installedPath), { recursive: true });

  if (runtime.platform === 'darwin') {
    writeFileSync(
      paths.installedPath,
      buildLaunchdPlistXml({
        label: paths.label,
        programArgs: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
        env: {
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
          HAPPIER_ACTIVE_SERVER_ID: serverId,
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        },
        stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
        stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
        workingDirectory: homeDir,
      }),
      'utf-8',
    );
    return;
  }

  if (runtime.platform === 'linux') {
    writeFileSync(
      paths.installedPath,
      renderSystemdServiceUnit({
        description: 'Happier Daemon',
        execStart: ['/usr/local/bin/happier', 'daemon', 'start-sync'],
        env: {
          HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
          HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
          HAPPIER_ACTIVE_SERVER_ID: serverId,
          HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
        },
        wantedBy: 'default.target',
      }),
      'utf-8',
    );
    return;
  }

  writeFileSync(
    paths.installedPath,
    renderWindowsScheduledTaskWrapperPs1({
      workingDirectory: homeDir,
      programArgs: ['C:\\hq\\happier.exe', 'daemon', 'start-sync'],
      env: {
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: homeDir,
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'pinned',
        HAPPIER_ACTIVE_SERVER_ID: serverId,
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      },
      stdoutPath: join(homeDir, 'logs', 'daemon-service.default.out.log'),
      stderrPath: join(homeDir, 'logs', 'daemon-service.default.err.log'),
    }),
    'utf-8',
  );
}

describe('multi-daemon helpers', () => {
  it('lists daemon status per saved server profile', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-' }, async ({ homeDir }) => {
      const accountId = 'acct_123';
      await writeDaemonSettingsFixture(homeDir, {
        machineIdByServerId: {
          company: 'machine_123',
        },
        machineIdByServerIdByAccountId: {
          company: {
            [accountId]: 'machine_abc',
          },
        },
      });

      const sleepy = spawnSleepyDetachedProcess();
      try {
        await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: 12345,
        });
        writeValidInstalledDaemonServiceForCurrentRuntime(homeDir, 'company');

        const serverDir = join(homeDir, 'servers', 'company');
        mkdirSync(serverDir, { recursive: true });
        const token = [
          Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
          Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url'),
          '',
        ].join('.');
        writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token, secret: null }, null, 2), { encoding: 'utf-8' });

        const results = await listDaemonStatusesForAllKnownServers();
        const company = results.find((r: { serverId: string }) => r.serverId === 'company');
        expect(company).toBeTruthy();
        expect(company!.daemon.running).toBe(true);
        expect(company?.auth).toEqual({
          authenticated: true,
          needsAuth: false,
          machineRegistered: true,
          machineId: 'machine_abc',
          accountId,
        });
        expect(company?.drift?.activeComparableKey).toBeTruthy();
        expect(company?.drift?.matchesActiveRelay).toBe(false);
        expect(company?.service).toMatchObject({
          installed: true,
          running: false,
        });
      } finally {
        await sleepy.kill();
      }
    });
  });

  it('fails closed when the access token cannot be scoped to an account even if a server-scoped machine id exists', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-opaque-token-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir, {
        machineIdByServerId: {
          company: 'machine-server-scoped',
        },
        machineIdByServerIdByAccountId: {
          company: {
            'acct_123': 'machine-account-scoped',
          },
        },
      });

      const sleepy = spawnSleepyDetachedProcess();
      try {
        await writeDaemonStateFixture(homeDir, 'company', {
          pid: sleepy.pid,
          httpPort: 12345,
        });

        const serverDir = join(homeDir, 'servers', 'company');
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(join(serverDir, 'access.key'), JSON.stringify({ token: 'not-a-jwt', secret: null }, null, 2), {
          encoding: 'utf-8',
        });

        const results = await listDaemonStatusesForAllKnownServers();
        const company = results.find((r: { serverId: string }) => r.serverId === 'company');
        expect(company).toBeTruthy();
        expect(company!.daemon.running).toBe(true);
        expect(company?.auth).toEqual({
          authenticated: true,
          needsAuth: true,
          machineRegistered: false,
          machineId: null,
          accountId: null,
        });
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
        expect(String((observed[0]?.headers ?? ({} as any)).Connection ?? '')).toBe('close');
        expect(String((observed[0]?.headers ?? ({} as any))['x-happier-daemon-token'] ?? '')).toBe('test-token');
        expect(await waitForProcessExit(sleepy.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(existsSync(statePath)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
        await sleepy.kill();
      }
    });
  });

  it('transfers managed local services without stopping sessions when requested', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-multi-daemon-transfer-services-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);

      const port = await reserveEphemeralPort();
      const sleepy = spawnSleepyDetachedProcess();
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: sleepy.pid,
        httpPort: port,
        controlToken: 'test-token',
      });

      const observed: Array<{ body: unknown }> = [];
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
        observed.push({ body: init?.body });
        try {
          process.kill(sleepy.pid, 'SIGTERM');
        } catch {
          // ignore
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      });

      try {
        await stopAllDaemonsBestEffort({ transferManagedLocalServices: true });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(observed[0]?.body ?? ''))).toEqual({
          transferManagedLocalServices: true,
        });
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
