import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('serverProfiles localServerUrl safety', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    vi.resetModules();
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('does not treat remote http URL as localServerUrl when legacy publicServerUrl exists', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-serverProfiles-local-safety-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

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

