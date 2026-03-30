import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_HOME_DIR',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_ACTIVE_SERVER_ID',
  'HAPPIER_SERVER_URL',
  'HAPPIER_WEBAPP_URL',
]);

describe('multiDaemon release ring scoping', () => {
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

  it('uses the ring-scoped daemon state file when listing statuses across servers', async () => {
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
});

