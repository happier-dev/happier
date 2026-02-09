import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_prompt: string, cb: (answer: string) => void) => cb('y'),
    close: () => {},
  }),
}));

import { reloadConfiguration } from '@/configuration';
import { readSettings } from '@/persistence';

import { handleAuthCommand } from './auth';

describe('happier auth logout', () => {
  it('logs out only from the active server by default', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-auth-logout-'));
    const prevHome = process.env.HAPPIER_HOME_DIR;
    const prevServerUrl = process.env.HAPPIER_SERVER_URL;
    const prevWebappUrl = process.env.HAPPIER_WEBAPP_URL;

    try {
      process.env.HAPPIER_HOME_DIR = home;
      delete process.env.HAPPIER_SERVER_URL;
      delete process.env.HAPPIER_WEBAPP_URL;

      mkdirSync(join(home, 'servers', 'official'), { recursive: true });
      mkdirSync(join(home, 'servers', 'company'), { recursive: true });

      await writeFile(
        join(home, 'servers', 'official', 'access.key'),
        JSON.stringify({ token: 'tok_official', secret: Buffer.from('x').toString('base64') }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(home, 'servers', 'company', 'access.key'),
        JSON.stringify({ token: 'tok_company', secret: Buffer.from('y').toString('base64') }, null, 2),
        'utf-8',
      );

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
        machineIdByServerId: { official: 'mid_official', company: 'mid_company' },
        machineIdConfirmedByServerByServerId: { official: true, company: true },
        lastChangesCursorByServerIdByAccountId: { official: { a: 1 }, company: { a: 2 } },
      };
      await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');

      reloadConfiguration();
      await handleAuthCommand(['logout']);

      expect(existsSync(join(home, 'servers', 'official', 'access.key'))).toBe(false);
      expect(existsSync(join(home, 'servers', 'company', 'access.key'))).toBe(true);

      const next = await readSettings();
      expect(next.machineIdByServerId?.official).toBeUndefined();
      expect(next.machineIdByServerId?.company).toBe('mid_company');
      expect(next.lastChangesCursorByServerIdByAccountId?.official).toBeUndefined();
      expect(next.lastChangesCursorByServerIdByAccountId?.company?.a).toBe(2);

      // Company credentials file content is preserved.
      const companyRaw = JSON.parse(await readFile(join(home, 'servers', 'company', 'access.key'), 'utf-8'));
      expect(companyRaw.token).toBe('tok_company');
    } finally {
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
