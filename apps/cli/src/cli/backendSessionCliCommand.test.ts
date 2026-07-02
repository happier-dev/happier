import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn(),
}));

const { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock } = vi.hoisted(() => ({
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock: vi.fn(async () => {
    delete process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
    return null;
  }),
}));

const { runSessionCommandSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
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
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroup:
    () => selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    runSessionCommand: (...args: unknown[]) => runSessionCommandSpy(...args),
  }),
}));

import { runBackendSessionCliCommand } from './runBackendSessionCliCommand';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { AIBackendProfileSchema, AccountSettingsSchema } from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { CommandContext } from '@/cli/commandRegistry';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';

afterEach(() => {
  vi.restoreAllMocks();
  runSessionCommandSpy.mockReset();
  spawnSyncSpy.mockReset();
  delete process.env.HAPPIER_CODEX_PATH;
  delete process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock.mockReset();
});

describe('runBackendSessionCliCommand', () => {
  function readRunBackendSessionCliCommandSource(): string {
    return readFileSync(new URL('./runBackendSessionCliCommand.ts', import.meta.url), 'utf8');
  }

  function makeJwtWithSub(sub: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
    return `${header}.${payload}.signature`;
  }

  it('resolves plugin runtime preferences through the provider catalog hook seam', () => {
    const source = readRunBackendSessionCliCommandSource();
    expect(source).toMatch(/resolveProviderSessionRuntimePreferences/);
    expect(source).not.toMatch(/@happier-dev\/plugins-opencode/);
    expect(source).not.toMatch(/agentId\s*={2,3}\s*['"]opencode['"]/);
    expect(source).not.toMatch(/resolveCodexSessionRuntimePreferences/);
    expect(source).not.toMatch(/agentId\s*={2,3}\s*['"]codex['"]/);
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
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
    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      credentials,
      happyHomeDir: expect.any(String),
    }));
  });

  it('self-migrates daemon-spawned runners out of the daemon service cgroup when the env gate is set', async () => {
    process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP = '1';

    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    });

    expect(selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock).toHaveBeenCalledTimes(1);
    expect(process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP).toBeUndefined();
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

    runSessionCommandSpy.mockImplementation(async (_backendId: string, params: any) => {
      expect(refreshed).toBe(false);
        expect(params.accountSettingsContext?.settings).toBe(cachedSettings);
    });

    const commandPromise = runBackendSessionCliCommand({
      context: { args: ['gemini'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'gemini',
      agentIdForAccountSettings: 'gemini' as any,
    });

    await commandPromise;
    expect(runSessionCommandSpy).toHaveBeenCalled();
  });

  it('ignores obsolete child account settings version hints for daemon-started sessions', async () => {
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--started-by', 'daemon', '--account-settings-version-hint', '9'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
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

    runSessionCommandSpy.mockImplementation(async (_backendId: string, params: any) => {
      expect(refreshed).toBe(false);
      expect(params.accountSettingsContext?.settings).toBe(cachedSettings);
    });

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--refresh-settings'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(bootstrapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'fast',
        refresh: 'force',
      }),
    );
    expect(runSessionCommandSpy).toHaveBeenCalled();
  });

  it('passes parsed provider-native arguments to provider extra option resolvers', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: ['codex', 'exec', '--model', 'gpt-5.1-codex-max', '--sandbox', 'workspace-write'],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
      forwardModelFlag: true,
      resolveExtraOptions: (_args, parsed) => ({
        providerArgsFromParsed: parsed.providerArgs,
      }),
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      modelId: 'gpt-5.1-codex-max',
      providerArgsFromParsed: ['exec', '--model', 'gpt-5.1-codex-max', '--sandbox', 'workspace-write'],
    }));
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(authSpy).not.toHaveBeenCalled();
    expect(ensureMachineSpy).toHaveBeenCalledWith(credentials);
  });

  it('passes provider spawn extras from account settings into the backend run', async () => {
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      codexBackendMode: 'acp',
    }));
    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('passes plugin-owned Kimi runtime preference environment into the backend run', async () => {
    const credentials = { token: 'x' } as any;

    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'network',
      settings: { kimiAcpPythonSelector: 'poll' } as any,
      settingsVersion: 1,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['kimi'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'kimi',
      agentIdForAccountSettings: 'kimi' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('kimi', expect.objectContaining({
      environmentVariables: {
        HAPPIER_KIMI_ACP_SELECTOR: 'poll',
      },
    }));
    expect(runSessionCommandSpy).toHaveBeenCalledWith('kimi', expect.not.objectContaining({
      kimiAcpPythonSelector: 'poll',
    }));
  });

  it('forwards canonical session-mode fields to the session bridge for direct CLI starts', async () => {
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: ['codex', '--agent-mode', 'plan', '--agent-mode-updated-at', '123'],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionModeId: 'plan',
      sessionModeUpdatedAt: 123,
    }));
    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.not.objectContaining({
      agentModeId: expect.anything(),
      agentModeUpdatedAt: expect.anything(),
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['acp-catalog'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'customAcp',
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
    expect(runSessionCommandSpy).toHaveBeenCalledWith('customAcp', expect.objectContaining({
      accountSettingsContext: expect.objectContaining({
        settings: expect.objectContaining({
          acpCatalogSettingsV1: { v: 2, backends: [] },
        }),
      }),
    }));
  });

  it('keeps Codex account settings ahead of explicit legacy ACP env overrides for direct CLI runs', async () => {
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

      runSessionCommandSpy.mockResolvedValue(undefined);

      await runBackendSessionCliCommand({
        context: { args: ['codex'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
        codexBackendMode: 'acp',
      }));
      expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.not.objectContaining({ experimentalCodexAcp: true }));
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

    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--resume', 'cli-resume'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      startedBy: 'terminal',
      resume: 'cli-resume',
      existingSessionId: undefined,
      codexBackendMode: 'acp',
    }));
    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.not.objectContaining({
      experimentalCodexAcp: true,
    }));
  });

  it('ignores the legacy Codex ACP env override for direct CLI runs and keeps the canonical settings-truth default', async () => {
    const previous = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '1';

    try {
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

      runSessionCommandSpy.mockResolvedValue(undefined);

      await runBackendSessionCliCommand({
        context: { args: ['codex'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
        agentIdForAccountSettings: 'codex' as any,
      });

      expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
        codexBackendMode: 'appServer',
      }));
      expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.not.objectContaining({
        experimentalCodexAcp: true,
      }));
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
      } else {
        process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = previous;
      }
    }
  });

  it('keeps daemon-selected canonical Codex backend mode ahead of account settings defaults', async () => {
    const previous = process.env.HAPPIER_CODEX_BACKEND_MODE;
    process.env.HAPPIER_CODEX_BACKEND_MODE = 'acp';

    try {
      const credentials: Credentials = {
        token: 'x',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      };
      const accountSettingsContext: AccountSettingsContext = {
        source: 'network',
        settings: AccountSettingsSchema.parse({}),
        settingsVersion: 1,
        settingsSecretsReadKeys: [],
        loadedAtMs: Date.now(),
        whenRefreshed: null,
      };
      const context: CommandContext = {
        args: ['codex', '--started-by', 'daemon'],
        rawArgv: ['codex', '--started-by', 'daemon'],
        terminalRuntime: null,
      };

      vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue(credentials);
      vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' });
      vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue(accountSettingsContext);

      runSessionCommandSpy.mockResolvedValue(undefined);

      await runBackendSessionCliCommand({
        context,
        backendIdForSessionRuntime: 'codex',
        agentIdForAccountSettings: 'codex',
      });

      expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
        startedBy: 'daemon',
        codexBackendMode: 'acp',
      }));
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_CODEX_BACKEND_MODE;
      } else {
        process.env.HAPPIER_CODEX_BACKEND_MODE = previous;
      }
    }
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

    runSessionCommandSpy.mockImplementation(async () => {
      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('work');
      expect(process.env.FOO).toBe('bar');
    });

    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
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

  it('short-circuits --help to the resolved provider CLI without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-codex-help-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);

    const readCredentialsSpy = vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--help'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
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
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
      expect(readCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
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
    try {
      await runBackendSessionCliCommand({
        context: { args: ['codex', '--version'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
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
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
      expect(readCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
