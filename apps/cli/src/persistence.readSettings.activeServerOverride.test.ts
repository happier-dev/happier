import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('readSettings (active server override)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('derives machineId from configuration.activeServerId when HAPPIER_SERVER_URL is set', async () => {
    await withTempDir('happier-cli-settings-active-server-', async (homeDir) => {
      const serverUrl = 'http://127.0.0.1:12345';
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: serverUrl,
        HAPPIER_WEBAPP_URL: serverUrl,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              env_placeholder: 'machine-env',
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
      const [{ configuration }, { readSettings }] = await Promise.all([
        import('./configuration'),
        import('./persistence'),
      ]);
      const envServerId = configuration.activeServerId;
      expect(envServerId).not.toBe('cloud');

      const raw = JSON.parse(readFileSync(join(homeDir, 'settings.json'), 'utf8'));
      raw.machineIdByServerId = { [envServerId]: 'machine-env' };
      writeFileSync(join(homeDir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf8');

      const settings = await readSettings();
      expect(settings.machineId).toBe('machine-env');
    });
  }, 15_000);

  it('clears machine id for the effective active server id under env override', async () => {
    await withTempDir('happier-cli-clear-machine-id-', async (homeDir) => {
      const serverUrl = 'http://127.0.0.1:23456';
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: serverUrl,
        HAPPIER_WEBAPP_URL: serverUrl,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              cloud: 'machine-cloud',
              env_placeholder: 'machine-env',
            },
            machineIdConfirmedByServerByServerId: {
              cloud: true,
              env_placeholder: true,
            },
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { configuration } = await import('./configuration');
      const envServerId = configuration.activeServerId;
      expect(envServerId).not.toBe('cloud');

      const seeded = JSON.parse(readFileSync(settingsPath, 'utf8'));
      seeded.machineIdByServerId = {
        cloud: 'machine-cloud',
        [envServerId]: 'machine-env',
      };
      seeded.machineIdConfirmedByServerByServerId = {
        cloud: true,
        [envServerId]: true,
      };
      writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf8');

      const { clearMachineId } = await import('./persistence');
      await clearMachineId();

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('machine-cloud');
      expect(raw.machineIdByServerId[envServerId]).toBeUndefined();
      expect(raw.machineIdConfirmedByServerByServerId.cloud).toBe(true);
      expect(raw.machineIdConfirmedByServerByServerId[envServerId]).toBeUndefined();
    });
  }, 15_000);

  it('uses HAPPIER_ACTIVE_SERVER_ID for machineId scope selection', async () => {
    await withTempDir('happier-cli-active-server-id-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:23456',
        HAPPIER_WEBAPP_URL: 'http://127.0.0.1:23456',
        HAPPIER_ACTIVE_SERVER_ID: 'stack_main__id_default',
      });
      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              cloud: 'machine-cloud',
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
    });
  });

  it('does not fall back to a server-scoped machine id when account-scoped bindings exist but the account scope is missing', async () => {
    await withTempDir('happier-cli-active-server-id-no-account-scope-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 6,
            onboardingCompleted: true,
            activeServerId: 'cloud',
            servers: {
              cloud: {
                id: 'cloud',
                name: 'cloud',
                serverUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
              },
            },
            machineIdByServerId: {
              cloud: 'machine-server-scoped',
            },
            machineIdByServerIdByAccountId: {
              cloud: {
                'acct-a': 'machine-account-scoped',
              },
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

      expect(settings.machineId).toBeUndefined();
    });
  });
});
