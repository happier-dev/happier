import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deriveServerIdFromUrl(url: string): string {
  // Mirror apps/cli/src/configuration.ts deriveServerIdFromUrl.
  let h = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

describe('readSettings (active server override)', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousServerUrl = process.env.HAPPIER_SERVER_URL;
  const previousWebappUrl = process.env.HAPPIER_WEBAPP_URL;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousServerUrl;
    if (previousWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousWebappUrl;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    vi.resetModules();
  });

  it('derives machineId from configuration.activeServerId when HAPPIER_SERVER_URL is set', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-settings-active-server-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:12345';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:12345';

    try {
      const envServerId = deriveServerIdFromUrl(process.env.HAPPIER_SERVER_URL);
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'official',
            servers: {
              official: {
                id: 'official',
                name: 'official',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              [envServerId]: 'machine-env',
            },
            machineIdConfirmedByServerByServerId: {},
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { readSettings } = await import('./persistence');
      const settings = await readSettings();
      expect(settings.machineId).toBe('machine-env');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('clears machine id for the effective active server id under env override', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-clear-machine-id-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:23456';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:23456';

    try {
      const envServerId = deriveServerIdFromUrl(process.env.HAPPIER_SERVER_URL);
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'official',
            servers: {
              official: {
                id: 'official',
                name: 'official',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              official: 'machine-official',
              [envServerId]: 'machine-env',
            },
            machineIdConfirmedByServerByServerId: {
              official: true,
              [envServerId]: true,
            },
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { clearMachineId } = await import('./persistence');
      await clearMachineId();

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.official).toBe('machine-official');
      expect(raw.machineIdByServerId[envServerId]).toBeUndefined();
      expect(raw.machineIdConfirmedByServerByServerId.official).toBe(true);
      expect(raw.machineIdConfirmedByServerByServerId[envServerId]).toBeUndefined();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('uses HAPPIER_ACTIVE_SERVER_ID for machineId scope selection', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-active-server-id-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_SERVER_URL = 'http://127.0.0.1:23456';
    process.env.HAPPIER_WEBAPP_URL = 'http://127.0.0.1:23456';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'stack_main__id_default';

    try {
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'official',
            servers: {
              official: {
                id: 'official',
                name: 'official',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              official: 'machine-official',
              stack_main__id_default: 'machine-stack',
            },
            machineIdConfirmedByServerByServerId: {},
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { readSettings } = await import('./persistence');
      const settings = await readSettings();
      expect(settings.machineId).toBe('machine-stack');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
