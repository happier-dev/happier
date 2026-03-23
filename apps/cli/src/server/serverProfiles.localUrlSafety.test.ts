import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('serverProfiles localServerUrl safety', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.resetModules();
  });

  it('does not treat remote http URL as localServerUrl when legacy publicServerUrl exists', async () => {
    await withTempDir('happier-cli-serverProfiles-local-safety-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });

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
                name: 'selfhost',
                serverUrl: 'http://public.example.test',
                publicServerUrl: 'https://public.example.test',
                webappUrl: 'https://app.happier.dev',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
              },
            },
            machineIdByServerId: {},
            machineIdConfirmedByServerByServerId: {},
            lastChangesCursorByServerIdByAccountId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { getServerProfile } = await import('./serverProfiles');
      const profile = await getServerProfile('s1');
      expect(profile.serverUrl).toBe('https://public.example.test');
      expect((profile as any).localServerUrl).toBeUndefined();
    });
  });
});
