import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('configuration server selection (persisted settings)', () => {
  const previousEnv = {
    homeDir: process.env.HAPPIER_HOME_DIR,
    serverUrl: process.env.HAPPIER_SERVER_URL,
    localServerUrl: process.env.HAPPIER_LOCAL_SERVER_URL,
    publicServerUrl: process.env.HAPPIER_PUBLIC_SERVER_URL,
    webappUrl: process.env.HAPPIER_WEBAPP_URL,
    activeServerId: process.env.HAPPIER_ACTIVE_SERVER_ID,
  };

  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousEnv.homeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousEnv.homeDir;

    if (previousEnv.serverUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = previousEnv.serverUrl;

    if (previousEnv.localServerUrl === undefined) delete process.env.HAPPIER_LOCAL_SERVER_URL;
    else process.env.HAPPIER_LOCAL_SERVER_URL = previousEnv.localServerUrl;

    if (previousEnv.publicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = previousEnv.publicServerUrl;

    if (previousEnv.webappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = previousEnv.webappUrl;

    if (previousEnv.activeServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousEnv.activeServerId;

    vi.resetModules();
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('does not treat remote http URL as localServerUrl when legacy publicServerUrl exists', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-config-server-selection-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
    delete process.env.HAPPIER_ACTIVE_SERVER_ID;

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

