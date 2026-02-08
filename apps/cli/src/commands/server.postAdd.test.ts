import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadConfiguration } from '@/configuration';

import { handleServerCommand } from './server';

describe('happier server add', () => {
  it('prints follow-up daemon commands in non-interactive mode when --use is set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
        '--use',
      ]);

      const out = logs.join('\n');
      expect(out).toContain('happier --server');
      expect(out).toContain('daemon start');
      expect(out).toContain('daemon service install');
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('prints follow-up daemon commands in non-interactive mode even when --use is not set', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-server-add-no-use-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;
      reloadConfiguration();

      await handleServerCommand([
        'add',
        '--name',
        'Company',
        '--server-url',
        'https://company.example.test',
        '--webapp-url',
        'https://company.example.test',
      ]);

      const out = logs.join('\n');
      expect(out).toContain('Next steps');
      expect(out).toContain('happier --server');
      expect(out).toContain('daemon start');
      expect(out).toContain('daemon service install');
    } finally {
      logSpy.mockRestore();
      if (prevHome === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = prevHome;
      if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = prevServerUrl;
      if (prevWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = prevWebappUrl;
      reloadConfiguration();
      await rm(home, { recursive: true, force: true });
    }
  });
});
