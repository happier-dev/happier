import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeJwtWithSub(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('authAndSetupMachineIfNeeded (machine id binding)', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
  const previousAutostart = process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    if (previousAutostart === undefined) delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;
    else process.env.HAPPIER_SESSION_AUTOSTART_DAEMON = previousAutostart;
    vi.resetModules();
  });

  it('selects machine id based on decoded token sub', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-auth-machine-id-sub-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    delete process.env.HAPPIER_SESSION_AUTOSTART_DAEMON;

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
            lastTokenSubByServerId: { cloud: 'acct-a' },
            machineIdByServerIdByAccountId: {
              cloud: {
                'acct-a': 'machine-acct-a',
                'acct-b': 'machine-acct-b',
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const serverDir = join(homeDir, 'servers', 'cloud');
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(
        join(serverDir, 'access.key'),
        JSON.stringify({ token: makeJwtWithSub('acct-b'), secret: Buffer.from('x').toString('base64') }, null, 2),
        'utf8',
      );

      vi.resetModules();
      const { authAndSetupMachineIfNeeded } = await import('./auth');
      const result = await authAndSetupMachineIfNeeded();

      expect(result.machineId).toBe('machine-acct-b');
      expect(result.credentials.token).toContain('.');

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe('machine-acct-b');
      expect(raw.lastTokenSubByServerId.cloud).toBe('acct-b');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
