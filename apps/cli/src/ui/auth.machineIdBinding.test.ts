import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: vi.fn(() => '00000000-0000-0000-0000-000000000001'),
  };
});

describe('ensureMachineIdInSettings', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    vi.resetModules();
  });

  it('returns the existing per-server machine id when present', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-id-binding-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
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
            machineIdByServerId: { cloud: 'machine-existing' },
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { ensureMachineIdInSettings } = await import('./auth');
      const result = await ensureMachineIdInSettings();
      expect(result.machineId).toBe('machine-existing');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('machine-existing');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('generates and persists a new machine id when missing for the active server', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-id-binding-account-swap-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
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
            machineIdByServerId: {},
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();
      const { ensureMachineIdInSettings } = await import('./auth');
      const result = await ensureMachineIdInSettings();
      expect(result.machineId).toBe('00000000-0000-0000-0000-000000000001');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('00000000-0000-0000-0000-000000000001');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('forceNew rotates the machine id for the current account', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-machine-id-binding-force-new-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';

    try {
      const settingsPath = join(homeDir, 'settings.json');
      writeFileSync(
        settingsPath,
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
            machineIdByServerId: { cloud: 'machine-acct-a' },
          },
          null,
          2,
        ),
        'utf8',
      );

      vi.resetModules();

      const crypto = await import('node:crypto');
      vi.mocked(crypto.randomUUID).mockImplementationOnce(() => '00000000-0000-0000-0000-000000000002');

      const { ensureMachineIdInSettings } = await import('./auth');
      const result = await ensureMachineIdInSettings({ forceNew: true });
      expect(result.machineId).toBe('00000000-0000-0000-0000-000000000002');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('00000000-0000-0000-0000-000000000002');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
