import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { reloadConfiguration } from '@/configuration';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon service list', () => {
  it('lists per-server installed unit paths on linux', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-daemon-service-list-'));
    const prevHappyHome = process.env.HAPPIER_HOME_DIR;
    const prevPlatform = process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
    const prevUserHome = process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      process.env.HAPPIER_HOME_DIR = home;
      process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = 'linux';
      process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = home;
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

      const unitDir = join(home, '.config', 'systemd', 'user');
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, 'happier-daemon.company.service'), '# fake', 'utf-8');

      await handleDaemonCliCommand({ args: ['daemon', 'service', 'list'], rawArgv: [], terminalRuntime: null });

      const out = logs.join('\n');
      expect(out).toContain('company');
      expect(out).toContain('happier-daemon.company.service');
      expect(out.toLowerCase()).toContain('installed');
    } finally {
      logSpy.mockRestore();
      if (prevHappyHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHappyHome;
      if (prevPlatform === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_PLATFORM;
      else process.env.HAPPIER_DAEMON_SERVICE_PLATFORM = prevPlatform;
      if (prevUserHome === undefined) delete process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR;
      else process.env.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR = prevUserHome;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });
});
