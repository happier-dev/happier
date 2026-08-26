import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncSpy } = vi.hoisted(() => ({
  spawnSyncSpy: vi.fn(),
}));

const { selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock } = vi.hoisted(() => ({
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock: vi.fn(async () => {
    delete process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
    return null;
  }),
}));

const { runSessionCommandSpy, runSessionCommandHostOptionsSpy } = vi.hoisted(() => ({
  runSessionCommandSpy: vi.fn(),
  runSessionCommandHostOptionsSpy: vi.fn(),
}));

const foregroundAdmissionMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
}));
const ensureDaemonRunningForSessionCommandMock = vi.hoisted(() => vi.fn());
const terminalPromptMocks = vi.hoisted(() => ({
  isInteractiveTerminal: vi.fn(() => false),
  promptSecret: vi.fn(),
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
    runSessionCommand: (
      backendId: unknown,
      params: unknown,
      hostOptions?: unknown,
    ) => {
      runSessionCommandHostOptionsSpy(hostOptions);
      return runSessionCommandSpy(backendId, params);
    },
  }),
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/controlClient')>();
  return {
    ...actual,
    admitDaemonForegroundAgentRuntime: foregroundAdmissionMocks.admit,
    releaseDaemonForegroundAgentRuntime: foregroundAdmissionMocks.release,
  };
});

vi.mock('@/daemon/ensureDaemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ensureDaemon')>();
  return {
    ...actual,
    ensureDaemonRunningForSessionCommand:
      ensureDaemonRunningForSessionCommandMock,
  };
});

vi.mock('@/terminal/prompts/promptInput', () => ({
  isInteractiveTerminal: terminalPromptMocks.isInteractiveTerminal,
}));

vi.mock('@/terminal/prompts/promptSecret', () => ({
  promptSecret: terminalPromptMocks.promptSecret,
}));

vi.mock(
  '@/agent/runtime/session/process/foregroundAgentRuntimeAdmissionClient',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@/agent/runtime/session/process/foregroundAgentRuntimeAdmissionClient')
    >();
    return {
      ...actual,
      claimDaemonForegroundAgentRuntimeEnvironment:
        foregroundAdmissionMocks.claim,
    };
  },
);

import {
  runBackendSessionCliCommand as runBackendSessionCliCommandProduction,
} from './runBackendSessionCliCommand';
import * as authModule from '@/ui/auth';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import * as catalogHooksModule from '@/session/runtime/catalogHooks';
import {
  AIBackendProfileSchema,
  AccountSettingsSchema,
  createProviderErrorV1,
  serializeSessionModelSelectionV1,
  SessionModelSelectionV1Schema,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { CommandContext } from '@/cli/commandRegistry';
import { logger } from '@/ui/logger';
import type { AccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import {
  serializeNativeForkSourceV1,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';

async function runBackendSessionCliCommand(
  params: Parameters<typeof runBackendSessionCliCommandProduction>[0],
): Promise<void> {
  const runtimeAuthorityAgentId =
    params.runtimeAuthorityAgentId
    ?? params.agentIdForAccountSettings
    ?? params.agentIdForDeprecatedAliases;
  await runBackendSessionCliCommandProduction({
    ...params,
    ...(runtimeAuthorityAgentId ? { runtimeAuthorityAgentId } : {}),
  });
}

async function resolveLateSessionCommandOptions(options: any): Promise<any> {
  if (typeof options.resolveLateEnvironment !== 'function') return options;
  const late = await options.resolveLateEnvironment({
    sessionId: 'canonical-session-test',
  });
  const unsetEnvironmentVariables = [
    ...new Map([
      ...(options.unsetEnvironmentVariables ?? []),
      ...late.unsetEnvironmentVariables,
    ].map((name: string) => [name.toLowerCase(), name])).values(),
  ];
  const unsetIdentities = new Set(
    unsetEnvironmentVariables.map((name: string) => name.toLowerCase()),
  );
  const environmentVariables = {
    ...(options.environmentVariables ?? {}),
    ...late.environmentVariables,
  };
  for (const name of Object.keys(environmentVariables)) {
    if (unsetIdentities.has(name.toLowerCase())) {
      delete environmentVariables[name];
    }
  }
  return {
    ...options,
    environmentVariables,
    unsetEnvironmentVariables:
      unsetEnvironmentVariables.length > 0
        ? unsetEnvironmentVariables
        : undefined,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  runSessionCommandSpy.mockReset();
  runSessionCommandHostOptionsSpy.mockReset();
  spawnSyncSpy.mockReset();
  delete process.env.HAPPIER_CODEX_PATH;
  delete process.env.HAPPIER_OPENCODE_PATH;
  delete process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP;
  selfMigrateDaemonSpawnedSessionProcessOutOfDaemonServiceCgroupMock.mockReset();
  ensureDaemonRunningForSessionCommandMock.mockReset();
  terminalPromptMocks.isInteractiveTerminal.mockReset();
  terminalPromptMocks.isInteractiveTerminal.mockReturnValue(false);
  terminalPromptMocks.promptSecret.mockReset();
});

beforeEach(() => {
  foregroundAdmissionMocks.admit.mockResolvedValue({
    ok: true,
    capability: {
      attemptId: 'attempt-test',
      admissionFilePath: '/private/foreground-admission.json',
      bootstrapFilePath: '/private/foreground-bootstrap.json',
      authorityFilePath: '/private/foreground-authority.json',
      descriptor: {
        v: 1,
        pluginId: 'codex-plugin',
        pluginVersion: '1.0.0',
        agentId: 'codex',
        backendId: 'codex',
        generation: 'generation-1',
      },
    },
    launchPolicy: {
      reservedEnvironmentVariableNames: [],
      profileSecretRequirementNamesMissingBinding: [],
    },
  });
  foregroundAdmissionMocks.claim.mockResolvedValue({
    ok: true,
    environment: {},
    unsetEnvironmentVariableNames: [],
    sensitiveEnvironmentVariableNames: [],
  });
  foregroundAdmissionMocks.release.mockResolvedValue(undefined);
  ensureDaemonRunningForSessionCommandMock.mockResolvedValue(undefined);
});

describe('runBackendSessionCliCommand', () => {
  function mockProcessExit() {
    return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  }

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
    const readStoredCredentialsSpy = vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    expect(readStoredCredentialsSpy).toHaveBeenCalled();
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
    expect(foregroundAdmissionMocks.admit).toHaveBeenCalledTimes(1);
  });

  it('passes host-resolved Session preference facts through the canonical catalog hook', async () => {
    const credentials = { token: 'x' } as Credentials;
    const profile = AIBackendProfileSchema.parse({
      id: 'work',
      name: 'Work',
      environmentVariables: [{ name: 'R0_61_PREFERENCE_ENV', value: 'profile-value' }],
      envVarRequirements: [],
      compatibility: {},
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });
    const settings = {
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
      profiles: [profile],
    };

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockResolvedValue({
      source: 'none',
      settings,
      settingsVersion: 0,
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    const resolvePreferences = vi
      .spyOn(catalogHooksModule, 'resolveProviderSessionRuntimePreferences')
      .mockResolvedValue({});
    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      await resolveLateSessionCommandOptions(options);
    });

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as CommandContext,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(resolvePreferences).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        settings,
        environment: expect.objectContaining({
          R0_61_PREFERENCE_ENV: 'profile-value',
        }),
        startOrigin: 'terminal',
        isExplicitCliSubcommand: true,
        parsed: expect.objectContaining({ agentArgs: expect.any(Array) }),
      }),
    );
    const preferenceInput = resolvePreferences.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(preferenceInput).not.toHaveProperty('processEnv');
    expect(preferenceInput).not.toHaveProperty('startedBy');
  });

  it('sends persisted terminal-resume Connected Services intent through foreground admission', async () => {
    const connectedServices = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected' as const,
          selection: 'profile' as const,
          profileId: 'persisted-resume-account',
        },
      },
    };
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(
      credentials,
    );
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(
      accountSettingsModule,
      'bootstrapAccountSettingsContext',
    ).mockResolvedValue({
      source: 'none',
      settings: {} as any,
      settingsVersion: 0,
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    runSessionCommandSpy.mockImplementation(
      async (_backendId: string, options: any) => {
        await resolveLateSessionCommandOptions(options);
      },
    );

    await runBackendSessionCliCommand({
      context: {
        args: ['codex', '--resume', 'agent-session-1'],
        rawArgv: ['happier', 'codex', '--resume', 'agent-session-1'],
        terminalRuntime: null,
        directSessionLaunch: { connectedServices },
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(foregroundAdmissionMocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(/^direct-/),
        agentId: 'codex',
        backendTarget: {
          kind: 'backend',
          backendId: 'codex',
          sourceKind: 'built_in',
        },
        connectedServices,
        vendorResumeId: 'agent-session-1',
      }),
      expect.any(Object),
    );
    expect(runSessionCommandSpy).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        startedBy: 'terminal',
        resume: 'agent-session-1',
      }),
    );
    expect(runSessionCommandHostOptionsSpy).toHaveBeenCalledWith({
      agentRuntimeRunnerBootstrapFilePath:
        '/private/foreground-bootstrap.json',
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/private/foreground-authority.json',
    });
    expect(foregroundAdmissionMocks.claim).toHaveBeenCalledTimes(1);
    expect(foregroundAdmissionMocks.release).toHaveBeenCalledTimes(1);
  });

  it('uses a runtime-authority Agent id without defaulting account-settings or deprecated-alias identities', async () => {
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(
      credentials,
    );
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    const bootstrapSpy = vi.spyOn(
      accountSettingsModule,
      'bootstrapAccountSettingsContext',
    );
    runSessionCommandSpy.mockImplementation(
      async (_backendId: string, options: any) => {
        await resolveLateSessionCommandOptions(options);
      },
    );

    await runBackendSessionCliCommand({
      context: {
        args: ['acme.external'],
        terminalRuntime: null,
      } as CommandContext,
      backendIdForSessionRuntime: 'acme.external.backend',
      runtimeAuthorityAgentId: 'acme.external',
    });

    expect(bootstrapSpy).not.toHaveBeenCalled();
    expect(foregroundAdmissionMocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'acme.external',
        backendTarget: {
          kind: 'backend',
          backendId: 'acme.external.backend',
          sourceKind: 'built_in',
        },
      }),
      expect.any(Object),
    );
    expect(runSessionCommandHostOptionsSpy).toHaveBeenCalledWith({
      agentRuntimeRunnerBootstrapFilePath:
        '/private/foreground-bootstrap.json',
      agentRuntimeDaemonServiceAuthorityFilePath:
        '/private/foreground-authority.json',
    });
    expect(foregroundAdmissionMocks.claim).toHaveBeenCalledTimes(1);
    expect(foregroundAdmissionMocks.release).toHaveBeenCalledTimes(1);
  });

  it('resolves the configured Connected Services default before foreground admission and sends the legacy binding ingress', async () => {
    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
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
    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      await resolveLateSessionCommandOptions(options);
    });

    await runBackendSessionCliCommand({
      context: {
        args: ['codex'],
        rawArgv: ['happier', 'codex'],
        terminalRuntime: null,
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(foregroundAdmissionMocks.admit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      connectedServices: expect.objectContaining({
        v: 1,
        bindingsByServiceId: expect.objectContaining({
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'team',
          },
        }),
      }),
    }), expect.any(Object));
    expect(foregroundAdmissionMocks.release).toHaveBeenCalledTimes(1);
  });

  it('passes explicit terminal-mode intent from the CLI owner to the host session runtime', async () => {
    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: ['antigravity', '--happy-starting-mode', 'terminal'],
        terminalRuntime: { mode: 'plain' },
      } as any,
      backendIdForSessionRuntime: 'antigravity',
      agentIdForDeprecatedAliases: 'antigravity' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('antigravity', expect.objectContaining({
      startingMode: 'terminal',
    }));
  });

  it('preserves daemon-spawned provider model identity to the host runtime without legacy dual writes', async () => {
    const credentials = { token: 'x' } as any;
    const modelSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'default',
      },
    });
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: ['codex', '--started-by', 'daemon', '--model-selection-v1', serializeSessionModelSelectionV1(modelSelection)],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection,
    }));
    const runtimeOptions = runSessionCommandSpy.mock.calls[0]?.[1] as Readonly<Record<string, unknown>>;
    expect(runtimeOptions).not.toHaveProperty('modelId');
    expect(runtimeOptions).not.toHaveProperty('modelUpdatedAt');
  });

  it('passes the daemon native fork source into host session runtime params', async () => {
    const credentials = { token: 'x' } as any;
    const nativeForkSource: NativeForkSource = {
      sessionId: 'source-session',
      providerSessionId: 'provider-session',
      cwd: '/tmp/source-project',
      target: {
        turnId: 'source-turn',
        providerCheckpoint: {
          providerCursor: 'checkpoint-1',
        },
      },
    };
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: [
          'codex',
          '--started-by',
          'daemon',
          '--native-fork-source-v1',
          serializeNativeForkSourceV1(nativeForkSource),
        ],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      nativeForkSource,
    }));
  });

  it('passes a daemon-owned session creation tag into the host runtime without provider passthrough', async () => {
    const credentials = { token: 'x' } as any;
    const sessionCreationTag = 'create:v1:9Qf8pTqHIQxEYXv3sHohC0y7sD2pRqclZxY_V_GKcJ0';
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockResolvedValue(undefined);

    await runBackendSessionCliCommand({
      context: {
        args: [
          'codex',
          '--started-by',
          'daemon',
          '--session-creation-tag-v1',
          sessionCreationTag,
        ],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    });

    expect(runSessionCommandSpy).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionCreationTag,
    }));
  });

  it('self-migrates daemon-spawned runners out of the daemon service cgroup when the env gate is set', async () => {
    process.env.HAPPIER_DAEMON_SPAWN_SELF_MIGRATE_CGROUP = '1';

    const credentials = { token: 'x' } as any;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

  it('does not force a second account-settings network refresh before daemon-started child startup', async () => {
    const credentials = { token: 'x' } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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
        mode: 'fast',
        refresh: 'auto',
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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
      modelSelection: expect.objectContaining({
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5.1-codex-max',
        },
      }),
      providerArgsFromParsed: ['exec', '--model', 'gpt-5.1-codex-max', '--sandbox', 'workspace-write'],
    }));
  });

  it('binds machine id selection to decoded token sub when credentials already exist', async () => {
    const credentials = { token: makeJwtWithSub('acct-b') } as any;

    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials } as any);
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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
    expect(foregroundAdmissionMocks.admit).not.toHaveBeenCalled();
    expect(runSessionCommandHostOptionsSpy).toHaveBeenCalledWith(undefined);
  });

  it('keeps Codex account settings ahead of explicit legacy ACP env overrides for direct CLI runs', async () => {
    const previous = process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP;
    process.env.HAPPIER_EXPERIMENTAL_CODEX_ACP = '0';

    try {
      const credentials = { token: 'x' } as any;

      vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

      vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

      vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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

  it('passes --profile env through the session child options without mutating process.env', async () => {
    const priorProfileId = process.env.HAPPIER_SESSION_PROFILE_ID;
    const priorFoo = process.env.FOO;
    const priorOpenAiApiKey = process.env.OPENAI_API_KEY;
    process.env.HAPPIER_SESSION_PROFILE_ID = 'ambient-profile';
    process.env.FOO = 'ambient-foo';
    process.env.OPENAI_API_KEY = 'ambient-native-key';

    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    foregroundAdmissionMocks.admit.mockResolvedValueOnce({
      ok: true,
      capability: {
        attemptId: 'attempt-test',
        admissionFilePath: '/private/foreground-admission.json',
        bootstrapFilePath: '/private/foreground-bootstrap.json',
        authorityFilePath: '/private/foreground-authority.json',
        descriptor: {
          v: 1,
          pluginId: 'codex-plugin',
          pluginVersion: '1.0.0',
          agentId: 'codex',
          backendId: 'codex',
          generation: 'generation-1',
        },
      },
      launchPolicy: {
        reservedEnvironmentVariableNames: ['OPENAI_API_KEY'],
        profileSecretRequirementNamesMissingBinding: [],
      },
    });

    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      options = await resolveLateSessionCommandOptions(options);
      expect(options.environmentVariables).toEqual({
        FOO: 'bar',
        HAPPIER_SESSION_PROFILE_ID: 'work',
      });
      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('ambient-profile');
      expect(process.env.FOO).toBe('ambient-foo');
      expect(options.unsetEnvironmentVariables).toContain(
        'OPENAI_API_KEY',
      );
      expect(foregroundAdmissionMocks.admit).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'codex',
        }),
        expect.any(Object),
      );
    });

    try {
      let markDaemonReady!: () => void;
      ensureDaemonRunningForSessionCommandMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          markDaemonReady = resolve;
        }),
      );
      const running = runBackendSessionCliCommand({
        context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'codex',
        agentIdForAccountSettings: 'codex' as any,
      });
      await vi.waitFor(() => {
        expect(
          ensureDaemonRunningForSessionCommandMock,
        ).toHaveBeenCalled();
      });
      expect(foregroundAdmissionMocks.admit).not.toHaveBeenCalled();
      markDaemonReady();
      await running;
      expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('ambient-profile');
      expect(process.env.FOO).toBe('ambient-foo');
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
      if (typeof priorOpenAiApiKey === 'string') {
        process.env.OPENAI_API_KEY = priorOpenAiApiKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    }
  });

  it('prompts after a secret-free corrupt SavedSecret refusal and claims a fresh admission', async () => {
    const credentials: Credentials = {
      token: 'x',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(1),
      },
    };
    const profile = AIBackendProfileSchema.parse({
      id: 'deepseek',
      name: 'DeepSeek',
      environmentVariables: [{
        name: 'ANTHROPIC_AUTH_TOKEN',
        value: '${DEEPSEEK_AUTH_TOKEN}',
      }],
      envVarRequirements: [{
        name: 'DEEPSEEK_AUTH_TOKEN',
        kind: 'secret',
        required: true,
      }],
      compatibility: {},
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(
      credentials,
    );
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(
      accountSettingsModule,
      'bootstrapAccountSettingsContext',
    ).mockResolvedValue({
      source: 'network',
      settings: {
        profiles: [profile],
        secretBindingsByProfileId: {
          deepseek: { DEEPSEEK_AUTH_TOKEN: 'secret-bound' },
        },
      } as any,
      settingsVersion: 9,
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    terminalPromptMocks.isInteractiveTerminal.mockReturnValue(true);
    terminalPromptMocks.promptSecret.mockResolvedValue(
      'prompted-secret',
    );
    foregroundAdmissionMocks.claim
      .mockResolvedValueOnce({
        ok: false,
        error: createProviderErrorV1(
          'provider_agent_runtime_unsupported',
          { sourceProfileId: 'deepseek' },
        ),
        profileSecretRecovery: {
          requirementNames: ['DEEPSEEK_AUTH_TOKEN'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        environment: {},
        unsetEnvironmentVariableNames: [],
        sensitiveEnvironmentVariableNames: [
          'DEEPSEEK_AUTH_TOKEN',
        ],
      });
    runSessionCommandSpy.mockImplementation(
      async (_backendId: string, options: any) => {
        options = await resolveLateSessionCommandOptions(options);
        expect(options.environmentVariables).toMatchObject({
          DEEPSEEK_AUTH_TOKEN: 'prompted-secret',
          ANTHROPIC_AUTH_TOKEN: 'prompted-secret',
          HAPPIER_SESSION_PROFILE_ID: 'deepseek',
        });
      },
    );

    await runBackendSessionCliCommand({
      context: {
        args: ['codex', '--profile', 'deepseek'],
        terminalRuntime: null,
      } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(terminalPromptMocks.promptSecret).toHaveBeenCalledTimes(1);
    expect(foregroundAdmissionMocks.admit).toHaveBeenCalledTimes(2);
    expect(foregroundAdmissionMocks.claim).toHaveBeenCalledTimes(2);
    expect(foregroundAdmissionMocks.claim.mock.calls[0]?.[0])
      .toMatchObject({
        foregroundSatisfiedProfileSecretRequirementNames: [],
      });
    expect(foregroundAdmissionMocks.claim.mock.calls[1]?.[0])
      .toMatchObject({
        foregroundSatisfiedProfileSecretRequirementNames: [
          'DEEPSEEK_AUTH_TOKEN',
        ],
      });
  });

  it('keeps daemon-authorized Provider auth ahead of Profile and ambient Agent auth', async () => {
    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const selection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    });
    const profile = AIBackendProfileSchema.parse({
      id: 'work',
      name: 'Work',
      environmentVariables: [
        { name: 'OPENAI_API_KEY', value: 'profile-key' },
        { name: 'KEEP_PROFILE', value: 'profile-value' },
      ],
      envVarRequirements: [],
      compatibility: {},
      isBuiltIn: false,
      createdAt: 0,
      updatedAt: 0,
      version: '1.0.0',
    });
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({
      machineId: 'machine-1',
    } as any);
    vi.spyOn(
      accountSettingsModule,
      'bootstrapAccountSettingsContext',
    ).mockResolvedValue({
      source: 'none',
      settings: { profiles: [profile] } as any,
      settingsVersion: 0,
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    foregroundAdmissionMocks.admit.mockResolvedValueOnce({
      ok: true,
      capability: {
        attemptId: 'attempt-test',
        admissionFilePath: '/private/foreground-admission.json',
        bootstrapFilePath: '/private/foreground-bootstrap.json',
        authorityFilePath: '/private/foreground-authority.json',
        descriptor: {
          v: 1,
          pluginId: 'codex-plugin',
          pluginVersion: '1.0.0',
          agentId: 'codex',
          backendId: 'codex',
          generation: 'generation-1',
        },
      },
      launchPolicy: {
        reservedEnvironmentVariableNames: ['OPENAI_API_KEY'],
        profileSecretRequirementNamesMissingBinding: [],
      },
    });
    foregroundAdmissionMocks.claim.mockResolvedValueOnce({
      ok: true,
      environment: {
        OPENAI_API_KEY: 'provider-key',
      },
      unsetEnvironmentVariableNames: ['CODEX_API_KEY'],
      sensitiveEnvironmentVariableNames: [],
    });
    runSessionCommandSpy.mockImplementation(
      async (_backendId: string, options: any) => {
        options = await resolveLateSessionCommandOptions(options);
        expect(options.environmentVariables).toMatchObject({
          OPENAI_API_KEY: 'provider-key',
          KEEP_PROFILE: 'profile-value',
          HAPPIER_SESSION_PROFILE_ID: 'work',
        });
        expect(options.environmentVariables).not.toHaveProperty(
          'HAPPIER_AGENT_RUNTIME_DAEMON_BRIDGE_TOKEN_FILE',
        );
        expect(options.unsetEnvironmentVariables).toContain(
          'CODEX_API_KEY',
        );
        expect(process.env.OPENAI_API_KEY).not.toBe('provider-key');
      },
    );

    await runBackendSessionCliCommand({
      context: {
        args: [
          'codex',
          '--profile',
          'work',
          '--model-selection-v1',
          serializeSessionModelSelectionV1(selection),
        ],
        terminalRuntime: null,
      } as CommandContext,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
    });

    expect(foregroundAdmissionMocks.release).toHaveBeenCalledTimes(1);
  });

  it('protects exact session-control variables from runtime and direct option overrides and unsets', async () => {
    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
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
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(catalogHooksModule, 'resolveProviderSessionRuntimePreferences').mockResolvedValue({
      environmentVariables: {
        HAPPIER_SESSION_PROFILE_ID: 'runtime-spoof',
      },
      unsetEnvironmentVariables: ['happier_session_mcp_selection_json'],
    });

    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      options = await resolveLateSessionCommandOptions(options);
      expect(options.environmentVariables).toEqual({
        FOO: 'bar',
        HAPPIER_SESSION_PROFILE_ID: 'work',
      });
      expect(options.unsetEnvironmentVariables).toBeUndefined();
    });

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
      resolveExtraOptions: () => ({
        environmentVariables: {
          HAPPIER_SESSION_MCP_SELECTION_JSON: 'direct-spoof',
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: 'direct-spoof',
          HAPPIER_PROVIDER_BINDING_LAUNCH_MATERIALIZATION_V1: 'direct-spoof',
        },
        unsetEnvironmentVariables: [
          'happier_session_profile_id',
          'happier_connected_service_target_materialized_root',
        ],
      }),
    });
  });

  it('applies late provider unsets to earlier profile and direct environment values', async () => {
    const credentials: Credentials = {
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);

    const profile = AIBackendProfileSchema.parse({
      id: 'work',
      name: 'Work',
      environmentVariables: [
        { name: 'OPENAI_API_KEY', value: 'profile-key' },
        { name: 'KEEP_PROFILE', value: 'profile-value' },
      ],
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
      scopeKey: 'scope-test',
      loadedAtMs: Date.now(),
      whenRefreshed: null,
    } as any);
    vi.spyOn(catalogHooksModule, 'resolveProviderSessionRuntimePreferences').mockResolvedValue({
      unsetEnvironmentVariables: ['openai_api_key', 'DIRECT_TOKEN'],
    });

    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      options = await resolveLateSessionCommandOptions(options);
      expect(options.environmentVariables).toEqual({
        KEEP_PROFILE: 'profile-value',
        KEEP_DIRECT: 'direct-value',
        HAPPIER_SESSION_PROFILE_ID: 'work',
      });
      expect(options.unsetEnvironmentVariables).toEqual(['openai_api_key', 'DIRECT_TOKEN']);
    });

    await runBackendSessionCliCommand({
      context: { args: ['codex', '--profile', 'work'], terminalRuntime: null } as any,
      backendIdForSessionRuntime: 'codex',
      agentIdForAccountSettings: 'codex' as any,
      resolveExtraOptions: () => ({
        environmentVariables: {
          OPENAI_API_KEY: 'direct-key',
          DIRECT_TOKEN: 'direct-token',
          KEEP_DIRECT: 'direct-value',
        },
      }),
    });
  });

  it('applies an in-memory scoped environment without mutating the parent process', async () => {
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const previous = process.env.PROVIDER_SCOPED_SECRET;

    runSessionCommandSpy.mockImplementation(async (_backendId: string, options: any) => {
      expect(options.environmentVariables).toMatchObject({ PROVIDER_SCOPED_SECRET: 'secret-a' });
      expect(options.unsetEnvironmentVariables).toContain('NATIVE_AUTH_KEY');
      expect(process.env.PROVIDER_SCOPED_SECRET).toBe(previous);
    });

    await runBackendSessionCliCommand({
      context: {
        args: ['codex'],
        rawArgv: ['happier', 'codex'],
        terminalRuntime: null,
        scopedEnvironment: {
          env: { PROVIDER_SCOPED_SECRET: 'secret-a' },
          unsetEnvKeys: ['NATIVE_AUTH_KEY'],
        },
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    });
  });

  it('releases foreground admission before a fatal command exit', async () => {
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    runSessionCommandSpy.mockRejectedValue(new Error('runtime failed after foreground admission'));
    let cleanedAtExit = false;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      cleanedAtExit = foregroundAdmissionMocks.release.mock.calls.length === 1;
      throw new Error(`exit:${String(code)}`);
    }) as never);

    await expect(runBackendSessionCliCommand({
      context: {
        args: ['codex'],
        rawArgv: ['happier', 'codex'],
        terminalRuntime: null,
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    })).rejects.toThrow('exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(cleanedAtExit).toBe(true);
    expect(foregroundAdmissionMocks.release).toHaveBeenCalledTimes(1);
  });

  it('reports a daemon-started host rejection after session creation and before its webhook', async () => {
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const startupError = Object.assign(
      new Error('post-session startup failure'),
      {
        argv: ['--token', 'argv-secret-value'],
        env: { OPENAI_API_KEY: 'env-secret-value' },
      },
    );
    let sessionCreated = false;
    const fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runSessionCommandSpy.mockImplementation(async () => {
      sessionCreated = true;
      throw startupError;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);

    await expect(runBackendSessionCliCommand({
      context: {
        args: ['codex', '--started-by', 'daemon'],
        rawArgv: ['happier', 'codex', '--started-by', 'daemon'],
        terminalRuntime: null,
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex',
    })).rejects.toThrow('exit:1');

    expect(sessionCreated).toBe(true);
    expect(fatalSpy).toHaveBeenCalledWith(startupError);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('uses the terminal continuation exit code for a required continuation refusal', async () => {
    const credentials = { token: 'x' } as Credentials;
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    const continuationError = new Error('Agent session continuation is unreachable.');
    continuationError.name = 'AgentSessionContinuationUnreachableError';
    runSessionCommandSpy.mockRejectedValue(continuationError);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);

    await expect(runBackendSessionCliCommand({
      context: {
        args: ['codex'],
        rawArgv: ['happier', 'codex'],
        terminalRuntime: null,
      },
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    })).rejects.toThrow('exit:78');

    expect(exitSpy).toHaveBeenCalledWith(78);
  });

  it('presents a typed Provider refusal with bounded recovery context before a nonzero direct-start exit', async () => {
    const credentials = { token: 'x' } as Credentials;
    const modelSelection = SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: 123,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_gateway',
        modelId: 'vendor/model',
      },
    });
    vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ machineId: 'machine-1' } as any);
    vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as any);
    foregroundAdmissionMocks.admit.mockResolvedValueOnce({
      ok: false,
      error: createProviderErrorV1('provider_feature_disabled', {
        connectionId: 'pc_gateway',
        machineId: 'machine-1',
      }),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);

    await expect(runBackendSessionCliCommand({
      context: {
        args: ['codex', '--model-selection-v1', serializeSessionModelSelectionV1(modelSelection)],
        terminalRuntime: null,
      } as CommandContext,
      backendIdForSessionRuntime: 'codex',
      agentIdForDeprecatedAliases: 'codex' as any,
    })).rejects.toThrow('exit:1');

    const output = errorSpy.mock.calls.flat().join('\n');
    expect(output).toContain('provider_feature_disabled');
    expect(output).toContain('Review Provider availability');
    expect(output).toContain('pc_gateway');
    expect(output).toContain('machine-1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(runSessionCommandSpy).not.toHaveBeenCalled();
  });

  it('short-circuits --help to the resolved provider CLI without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-codex-help-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexPath = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    mkdirSync(root, { recursive: true });
    writeFileSync(codexPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(codexPath, 0o755);
    process.env.HAPPIER_CODEX_PATH = codexPath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);

    const readStoredCredentialsSpy = vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const exitSpy = mockProcessExit();
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
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      );
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
      expect(readStoredCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
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

    const readStoredCredentialsSpy = vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const exitSpy = mockProcessExit();
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
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      );
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
      expect(readStoredCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('short-circuits provider-native info command prefixes without auth or session startup', async () => {
    const root = join(tmpdir(), `happier-opencode-info-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const opencodePath = join(root, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
    mkdirSync(root, { recursive: true });
    writeFileSync(opencodePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(opencodePath, 0o755);
    process.env.HAPPIER_OPENCODE_PATH = opencodePath;
    spawnSyncSpy.mockReturnValue({ status: 0, signal: null, error: undefined } as any);

    const readStoredCredentialsSpy = vi.spyOn(persistenceModule, 'readStoredCredentials').mockResolvedValue({ token: 'x' } as any);
    const authSpy = vi.spyOn(authModule, 'authAndSetupMachineIfNeeded').mockResolvedValue({ credentials: { token: 'x' } } as any);
    const exitSpy = mockProcessExit();
    try {
      await runBackendSessionCliCommand({
        context: { args: ['opencode', 'providers', 'list'], terminalRuntime: null } as any,
        backendIdForSessionRuntime: 'opencode',
        agentIdForAccountSettings: 'opencode' as any,
        providerInfoCommandPrefixes: [['providers', 'list']],
      });

      expect(spawnSyncSpy).toHaveBeenCalledWith(
        opencodePath,
        ['providers', 'list'],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }),
      );
      expect(runSessionCommandSpy).not.toHaveBeenCalled();
      expect(readStoredCredentialsSpy).not.toHaveBeenCalled();
      expect(authSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
