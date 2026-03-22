import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('configuration server selection (persisted settings)', () => {
  const envKeys = [
    'HAPPIER_HOME_DIR',
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_PUBLIC_SERVER_URL',
    'HAPPIER_WEBAPP_URL',
    'HAPPIER_ACTIVE_SERVER_ID',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('does not treat remote http URL as localServerUrl when legacy publicServerUrl exists', async () => {
    await withTempDir('happier-cli-config-server-selection-', async (homeDir) => {
      envScope.patch({
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_SERVER_URL: undefined,
        HAPPIER_LOCAL_SERVER_URL: undefined,
        HAPPIER_PUBLIC_SERVER_URL: undefined,
        HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined,
      });

      writeFileSync(
        join(homeDir, 'settings.json'),
        JSON.stringify(
          {
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: 's1',
            servers: {
              s1: {
                id: 's1',
                name: 'Selfhost',
                serverUrl: 'http://public.example.test',
                publicServerUrl: 'https://public.example.test',
                webappUrl: 'https://app.happier.dev',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const configMod = await import('@/configuration');
      configMod.reloadConfiguration();

      expect(configMod.configuration.serverUrl).toBe('https://public.example.test');
      expect(configMod.configuration.apiServerUrl).toBe('https://public.example.test');
    });
  });
});
