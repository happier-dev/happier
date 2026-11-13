import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { ensureMachineIdForCredentials, ensureMachineIdInSettings } from './auth';
import { readStoredCredentials } from '@/persistence';
import { createRequesterSessionCredentialCustody } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { runInHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

describe('ensureMachineIdInSettings', () => {
  const previousHomeDir = process.env.HAPPIER_HOME_DIR;
  const previousActiveServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;

  afterEach(() => {
    if (previousHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = previousHomeDir;
    if (previousActiveServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = previousActiveServerId;
    reloadConfiguration();
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

      reloadConfiguration();
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

      reloadConfiguration();
      const result = await ensureMachineIdInSettings();
      expect(result.machineId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe(result.machineId);
      expect((await ensureMachineIdInSettings()).machineId).toBe(result.machineId);
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

      reloadConfiguration();
      const result = await ensureMachineIdInSettings({ forceNew: true });
      expect(result.machineId).not.toBe('machine-acct-a');
      expect(result.machineId).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u);

      const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(raw.machineIdByServerId.cloud).toBe(result.machineId);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it.each([false, true])('keeps requester Session startup on its admitted Machine without changing custodian settings (hosted=%s)', async (hosted) => {
    const homeDir = mkdtempSync(join(tmpdir(), 'happier-cli-requester-machine-binding-'));
    const scope = createEnvKeyScope(['HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE', 'HAPPIER_SESSION_REQUESTER_SESSION_ID']);
    process.env.HAPPIER_HOME_DIR = homeDir;
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'cloud';
    const settingsPath = join(homeDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ schemaVersion: 6, onboardingCompleted: true,
      activeServerId: 'cloud', servers: { cloud: { id: 'cloud', name: 'cloud',
        serverUrl: 'https://api.happier.dev', webappUrl: 'https://app.happier.dev',
        createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
      machineIdByServerId: { cloud: 'custodian-machine' }, lastTokenSubByServerId: { cloud: 'custodian' },
      machineIdByServerIdByAccountId: { cloud: { custodian: 'custodian-machine' } },
      machineIdConfirmedByServerByServerId: { cloud: true },
    }));
    reloadConfiguration();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url');
    const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: homeDir,
      sessionId: 'requester-session',
      attribution: { serverId: 'cloud', accountId: 'requester', machineId: 'custodian-machine', installationId: 'installation' },
      credentials: { token: `${header}.${payload}.signature`, encryption: null },
    });
    try {
      const environment = { HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: custody.path,
        HAPPIER_SESSION_REQUESTER_SESSION_ID: 'requester-session' };
      if (!hosted) scope.patch(environment);
      const run = <T>(callback: () => T): T => hosted ? runInHostedSessionScope({ environment }, callback) : callback();
      const credentials = await run(readStoredCredentials);
      expect(credentials).not.toBeNull();
      if (!credentials) throw Error('requester custody fixture unavailable');
      const before = readFileSync(settingsPath, 'utf8');
      expect(await run(() => ensureMachineIdForCredentials(credentials))).toEqual({ machineId: 'custodian-machine' });
      expect(await run(() => ensureMachineIdForCredentials(credentials, { forceNew: true }))).toEqual({ machineId: 'custodian-machine' });
      await expect(run(() => ensureMachineIdForCredentials({ ...credentials }))).rejects.toThrow('requester_session_credentials_unavailable');
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    } finally {
      scope.restore();
      await custody.cleanup();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
