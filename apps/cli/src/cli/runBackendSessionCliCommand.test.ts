import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn(),
}));

const { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup } = vi.hoisted(() => ({
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup: vi.fn(async () => null),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: spawnSyncSpy,
  };
});

vi.mock('@/daemon/platform/linux/daemonSpawnedSessionCgroupSelfMigration', () => ({
  HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP_ENV_KEY: 'HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP',
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup,
}));

import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as providerSettingsModule from '@/settings/providerSettings';
import { logger } from '@/ui/logger';
import { AIBackendProfileSchema } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncSpy.mockReset();
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup.mockReset();
  delete process.env.HAPPIER_CODEX_PATH;
  delete process.env.HAPPIER_CODEX_BACKEND_MODE;
  delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
  delete process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
  delete process.env.CONNECTED_SERVICE_TEST_TOKEN;
});

describe('runBackendSessionCliCommand', () => {
  function makeJwtWithSub(sub: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  it('reports a daemon-started backend rejection after session creation and before its webhook', async () => {
    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const startupError = Object.assign(new Error('post-session startup failure'), {
      argv: ['--token', 'argv-secret-value'],
      env: { OPENAI_API_KEY: 'env-secret-value' },
    });
    let sessionCreated = false;
    let webhookSent = false;
    const run = vi.fn(async () => {
      sessionCreated = true;
      throw startupError;
    });
    const fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code ?? ''})`);
    }) as typeof process.exit);

    await expect(runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon'], terminalRuntime: null } as any,
      loadRun: async () => run,
      agentIdForAccountSettings: 'codex' as any,
    })).rejects.toThrow('process.exit(1)');

    expect(sessionCreated).toBe(true);
    expect(webhookSent).toBe(false);
    expect(fatalSpy).toHaveBeenCalledWith(startupError);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.anything(), 'post-session startup failure');
    exitSpy.mockRestore();
  });

  it('fast-paths terminal starts by avoiding auth/setup and using fast account settings bootstrap', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(readCredentialsSpy).toHaveBeenCalled();
    expect(authSpy).not.toHaveBeenCalled();
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex',
        credentials,
        mode: 'fast',
        refresh: 'auto',
      }),
    );
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ credentials }));
  });

  it('materializes the configured Connected Services default for a direct backend launch', async () => {
    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: {
        connectedServicesDefaultAuthByAgentIdV1: {
          v: 1,
          bindingsByAgentId: {
            codex: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': {
                  source: 'connected',
                  selection: 'group',
                  groupId: 'team',
                },
              },
            },
          },
        },
      },
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const cleanup = vi.fn();
    const materialize = vi.fn(async ({ connectedServices }: any) => ({
      env: { CONNECTED_SERVICE_TEST_TOKEN: 'selected' },
      cleanupOnFailure: cleanup,
      cleanupOnExit: cleanup,
      connectedServices,
    }));
    const run = vi.fn(async () => {
      expect(process.env.CONNECTED_SERVICE_TEST_TOKEN).toBe('selected');
    });

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun: async () => run,
      agentIdForAccountSettings: 'codex' as any,
      resolveDirectConnectedServiceEnvironmentFn: materialize,
    });

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          openai: { source: 'native' },
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        },
      },
    }));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(process.env.CONNECTED_SERVICE_TEST_TOKEN).toBeUndefined();
  });

  it('uses the cached fast account settings snapshot without waiting for refresh', async () => {
    const credentials = { token: 'x' } as any;

	    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
	    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);

	    const cachedSettings = { schemaVersion: 6, marker: 'cached' } as any;
	    let refreshed = false;
	    const whenRefreshed = new Promise<any>(() => {});

    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
	      settings: cachedSettings,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

	    const run = vi.fn(async (params: any) => {
	      expect(refreshed).toBe(false);
        expect(params.accountSettingsContext?.settings).toBe(cachedSettings);
	    });
	    const loadRun = vi.fn().mockResolvedValue(run);

	    const commandPromise = runBackendSessionCliCommand({
	      context: { args: ['gemini'], terminalRuntime: null } as any,
	      loadRun,
	      agentIdForAccountSettings: 'gemini' as any,
	    });

	    await commandPromise;
	    expect(run).toHaveBeenCalled();
	  });

  it('forces a fresh blocking account settings bootstrap for daemon-started sessions', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'blocking',
        refresh: 'force',
      }),
    );
  });

  it('ignores obsolete child account settings version hints for daemon-started sessions', async () => {
    const credentials = { token: 'x' } as Credentials;

    vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: {} as any,
      settingsVersion: 9,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon', '--account-settings-version-hint', '9'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'blocking',
        refresh: 'force',
      }),
    );
    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({
        minSettingsVersion: expect.any(Number),
      }),
    );
    expect(run).toHaveBeenCalled();
  });

  it('self-migrates daemon-spawned linux session runners out of the daemon service cgroup before continuing startup', async () => {
    const credentials = { token: 'x' } as any;

    process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP = '1';
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup).toHaveBeenCalledTimes(1);
  });

  it('forces refresh without blocking Codex terminal starts on fast account settings', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const cachedSettings = { schemaVersion: 6, marker: 'cached' } as any;
    let refreshed = false;
    const whenRefreshed = new Promise<any>(() => {});
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'cache',
      settings: cachedSettings,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed,
    } as any);

    const run = vi.fn(async (params: any) => {
      expect(refreshed).toBe(false);
      expect(params.accountSettingsContext?.settings).toBe(cachedSettings);
    });
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--refresh-settings'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fast',
        refresh: 'force',
      }),
    );
    expect(run).toHaveBeenCalled();
  });

  it('binds machine id selection to decoded token sub when credentials already exist', async () => {
    const credentials = { token: makeJwtWithSub('acct-b') } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    const ensureMachineSpy = vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-acct-b' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(ensureMachineSpy).toHaveBeenCalledWith(credentials);
  });

  it('passes provider spawn extras from account settings into the backend run', async () => {
    const credentials = { token: 'x' } as any;

    delete process.env.HAPPIER_CODEX_BACKEND_MODE;
    delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: { codexBackendMode: 'acp' } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      codexBackendMode: 'acp',
    }));
    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('falls back to the legacy Codex ACP flag only when no canonical backend mode is present', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: {} as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderSpawnExtrasForRuntime').mockReturnValue({
      experimentalCodexAcp: true,
    });

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      experimentalCodexAcp: true,
    }));
    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({
      codexBackendMode: expect.anything(),
    }));
  });

  it('passes Cursor provider runtime settings through direct CLI session starts', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: {
        cursorBinaryPath: '/opt/cursor/cursor-agent',
        cursorAgentFallbackEnabled: false,
        cursorApiEndpoint: 'https://cursor.example.test',
      } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderSpawnExtrasForRuntime').mockReturnValue({
      cursorBinaryPath: '/opt/cursor/cursor-agent',
      cursorAgentFallbackEnabled: false,
      cursorApiEndpoint: 'https://cursor.example.test',
    });

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['cursor'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'cursor' as any,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      cursorBinaryPath: '/opt/cursor/cursor-agent',
      cursorAgentFallbackEnabled: false,
      cursorApiEndpoint: 'https://cursor.example.test',
    }));
  });

  it('can force account settings loading without a built-in agent id', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    const bootstrapSpy = vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: { acpCatalogSettingsV1: { v: 2, backends: [] } } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['acp-catalog'], terminalRuntime: null } as any,
      loadRun,
      loadAccountSettings: true,
    });

    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials,
        mode: 'fast',
        refresh: 'auto',
      }),
    );
    expect(bootstrapSpy.mock.calls[0]?.[0]).not.toHaveProperty('agentId');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      accountSettingsContext: expect.objectContaining({
        settings: expect.objectContaining({
          acpCatalogSettingsV1: { v: 2, backends: [] },
        }),
      }),
    }));
  });

  it('lets an explicit Codex ACP env override win over account settings for direct CLI runs', async () => {
    const previous = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '0';

    try {
      const credentials = { token: 'x' } as any;

      vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
      vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
      vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
        source: 'network',
        settings: { codexBackendMode: 'acp' } as any,
        settingsVersion: 1,
        loadedAtMs: Date.now(),
        whenRefreshed: null,
      } as any);

      const run = vi.fn().mockResolvedValue(undefined);
      const loadRun = vi.fn().mockResolvedValue(run);

      await runBackendSessionCliCommand({
        context: { args: ['codex'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(run).toHaveBeenCalledWith(expect.not.objectContaining({ experimentalCodexAcp: true }));
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
      } else {
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = previous;
      }
    }
  });

  it('does not let provider spawn extras override core session start fields', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: { codexBackendMode: 'acp' } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(providerSettingsModule, 'resolveProviderSpawnExtrasForRuntime').mockReturnValue({
      codexBackendMode: 'acp',
      experimentalCodexAcp: true,
      startedBy: 'daemon',
      resume: 'provider-resume',
      existingSessionId: 'provider-session',
    });

    const run = vi.fn().mockResolvedValue(undefined);
    const loadRun = vi.fn().mockResolvedValue(run);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--resume', 'cli-resume'], terminalRuntime: null } as any,
      loadRun,
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      startedBy: 'terminal',
      resume: 'cli-resume',
      existingSessionId: undefined,
      codexBackendMode: 'acp',
    }));
    expect(run).toHaveBeenCalledWith(expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('applies --profile env overlay and exposes profile id via HAPPIER_SESSION_PROFILE_ID', async () => {
    const priorProfileId = process.env.HAPPIER_SESSION_PROFILE_ID;
    const priorFoo = process.env.FOO;

    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);

    const profile = AIBackendProfileSchema.parse({
      id: 'work',
      name: 'Work',
      environmentVariables: [{ name: 'FOO', value: 'bar' }],
      envVarRequirements: [],
      compatibility: {},
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });

    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings: { profiles: [profile] } as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    const run = vi.fn(async () => {
      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('work');
      expect(process.env.FOO).toBe('bar');
    });
    const loadRun = vi.fn().mockResolvedValue(run);

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      });
    } finally {
      if (typeof priorProfileId === 'string') {
        process.env.HAPPIER_SESSION_PROFILE_ID = priorProfileId;
      } else {
        delete process.env.HAPPIER_SESSION_PROFILE_ID;
      }
      if (typeof priorFoo === 'string') {
        process.env.FOO = priorFoo;
      } else {
        delete process.env.FOO;
      }
    }
  });

  it('shows combined Happier and provider help without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-codex-help-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const loadRun = vi.fn();

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--help'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        codexPath,
        ['--help'],
        expect.objectContaining({
          stdio: 'inherit',
          windowsHide: true,
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('happier'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex CLI Options'));
      expect(loadRun).not.toHaveBeenCalled();
      expect(readCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('forwards provider subcommand context when showing combined help', async () => {
    const root = join(tmpdir(), `happier-codex-subcommand-help-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const loadRun = vi.fn();

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', 'exec', '--help'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        codexPath,
        ['exec', '--help'],
        expect.objectContaining({
          stdio: 'inherit',
          windowsHide: true,
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('codex exec --help'));
      expect(loadRun).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('short-circuits --version to the resolved provider CLI without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-codex-version-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);

    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const loadRun = vi.fn();

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--version'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        codexPath,
        ['--version'],
        expect.objectContaining({
          stdio: 'inherit',
          windowsHide: true,
        }),
      );
      expect(loadRun).not.toHaveBeenCalled();
      expect(readCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('short-circuits Codex -V to the resolved provider CLI without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-codex-version-uppercase-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);

    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const loadRun = vi.fn();

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '-V'], terminalRuntime: null } as any,
        loadRun,
        agentIdForAccountSettings: 'codex' as any,
        versionFlags: ['-v', '-V', '--version'],
      });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        codexPath,
        ['-V'],
        expect.objectContaining({
          stdio: 'inherit',
          windowsHide: true,
        }),
      );
      expect(loadRun).not.toHaveBeenCalled();
      expect(readCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
