import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';

import { spawnSleepyDetachedProcess } from './testkit/fakeDaemonLifecycle.testkit';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
]);

describe('multiDaemon daemon ownership path resolution', () => {
  let homeDir = '';

  afterEach(() => {
    envScope.restore();
    if (homeDir && homeDir.startsWith(tmpdir())) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    vi.resetModules();
  });

  it('prefers the canonical daemon state file and still reports a legacy ring-scoped daemon state path when only that legacy file exists', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-ring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    // Seed a minimal settings file with a cloud server profile so the list is deterministic.
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: 12345,
          httpPort: 7777,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.0',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
  });

  it('uses the canonical daemon state file for status even when the current release ring is dev', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7778,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.1',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('falls back to a valid legacy ring-scoped daemon state when the canonical file is unreadable', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-canonical-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(join(serverDir, 'daemon.state.json'), '{not-json', 'utf-8');
    writeFileSync(
      join(serverDir, 'daemon.dev.state.json'),
      JSON.stringify(
        {
          pid: process.pid,
          httpPort: 7779,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.2',
        },
        null,
        2,
      ),
      'utf-8',
    );

    vi.resetModules();
    const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

    const entries = await listDaemonStatusesForAllKnownServers();
    const cloud = entries.find((entry) => entry.serverId === 'cloud');
    expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
    expect(cloud?.daemon.pid).toBe(process.pid);
    expect(cloud?.daemon.running).toBe(true);
  });

  it('skips a stale canonical daemon state and uses a later live legacy ring-scoped state', async () => {
    homeDir = join(tmpdir(), `happier-multi-daemon-stale-canonical-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      HAPPIER_SERVER_URL: 'https://api.happier.dev',
      HAPPIER_WEBAPP_URL: 'https://app.happier.dev',
    });

    mkdirSync(homeDir, { recursive: true });
    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          servers: {
            cloud: {
              id: 'cloud',
              name: 'Cloud',
              serverUrl: 'https://api.happier.dev',
              webappUrl: 'https://app.happier.dev',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const serverDir = join(homeDir, 'servers', 'cloud');
    mkdirSync(serverDir, { recursive: true });
    writeFileSync(
      join(serverDir, 'daemon.state.json'),
      JSON.stringify(
        {
          pid: Number.MAX_SAFE_INTEGER,
          httpPort: 7780,
          startedAt: Date.now(),
          startedWithCliVersion: '0.1.3',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const sleepy = spawnSleepyDetachedProcess();
    try {
      writeFileSync(
        join(serverDir, 'daemon.dev.state.json'),
        JSON.stringify(
          {
            pid: sleepy.pid,
            httpPort: 7781,
            startedAt: Date.now(),
            startedWithCliVersion: '0.1.4',
          },
          null,
          2,
        ),
        'utf-8',
      );

      vi.resetModules();
      const { listDaemonStatusesForAllKnownServers } = await import('./multiDaemon');

      const entries = await listDaemonStatusesForAllKnownServers();
      const cloud = entries.find((entry) => entry.serverId === 'cloud');
      expect(cloud?.daemonStatePath).toBe(join(serverDir, 'daemon.dev.state.json'));
      expect(cloud?.daemon.pid).toBe(sleepy.pid);
      expect(cloud?.daemon.running).toBe(true);
      expect(cloud?.daemon.staleStateFile).toBe(false);
    } finally {
      await sleepy.kill();
    }
  });
});
