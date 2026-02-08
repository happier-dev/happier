import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('server profile persistence', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;
    vi.resetModules();
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('loads serverUrl/webappUrl from active server profile when env vars are unset', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-profiles-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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
              serverUrl: 'https://stack.example.test',
              webappUrl: 'https://app.example.test',
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
    );

    vi.resetModules();
    const { configuration } = await import('./configuration');
    expect(configuration.serverUrl).toBe('https://stack.example.test');
    expect(configuration.webappUrl).toBe('https://app.example.test');
  });

  it('writes credentials to a per-server access.key file', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-server-cred-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_SERVER_URL;
    delete process.env.HAPPIER_WEBAPP_URL;

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
    );

    vi.resetModules();
    const { writeCredentialsLegacy } = await import('./persistence');

    await writeCredentialsLegacy({ secret: new Uint8Array(32).fill(2), token: 't' });

    const expected = join(homeDir, 'servers', 'official', 'access.key');
    expect(existsSync(expected)).toBe(true);
  });
});
