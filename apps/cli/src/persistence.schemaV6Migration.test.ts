import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('settings schema v6 migration', () => {
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

  it('migrates v5 publicServerUrl into canonical serverUrl and stores localServerUrl when serverUrl is local-ish', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-settings-v6-migrate-'));
    tempDirs.push(homeDir);
    process.env.HAPPIER_HOME_DIR = homeDir;

    writeFileSync(
      join(homeDir, 'settings.json'),
      JSON.stringify(
        {
          schemaVersion: 5,
          onboardingCompleted: true,
          activeServerId: 'local',
          servers: {
            local: {
              id: 'local',
              name: 'Local',
              serverUrl: 'http://127.0.0.1:53545',
              publicServerUrl: 'https://my-stack.example.test',
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
    const { readSettings } = await import('./persistence');
    const settings = await readSettings();

    expect(settings.schemaVersion).toBe(6);
    const local = (settings.servers as any)?.local;
    expect(local?.serverUrl).toBe('https://my-stack.example.test');
    expect(local?.localServerUrl).toBe('http://127.0.0.1:53545');
    expect(local?.publicServerUrl).toBeUndefined();
  });

  it('keeps v5 serverUrl as canonical when publicServerUrl is empty or matches', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-settings-v6-migrate-noop-'));
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
              name: 'Selfhost',
              serverUrl: 'https://stack.example.test',
              publicServerUrl: 'https://stack.example.test',
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
      'utf8',
    );

    vi.resetModules();
    const { readSettings } = await import('./persistence');
    const settings = await readSettings();

    expect(settings.schemaVersion).toBe(6);
    const s1 = (settings.servers as any)?.s1;
    expect(s1?.serverUrl).toBe('https://stack.example.test');
    expect(s1?.localServerUrl).toBeUndefined();
  });

  it('does not store localServerUrl when v5 serverUrl is remote http (avoid https downgrade)', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-settings-v6-migrate-no-downgrade-'));
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
              name: 'Selfhost',
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
    const { readSettings } = await import('./persistence');
    const settings = await readSettings();

    expect(settings.schemaVersion).toBe(6);
    const s1 = (settings.servers as any)?.s1;
    expect(s1?.serverUrl).toBe('https://public.example.test');
    expect(s1?.localServerUrl).toBeUndefined();
  });
});
