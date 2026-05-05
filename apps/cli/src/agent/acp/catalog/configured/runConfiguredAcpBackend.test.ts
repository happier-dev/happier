import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  buildConfiguredAcpBackendSessionMetadataMock,
  createCatalogProviderAcpRuntimeMock,
  createConfiguredAcpBackendMock,
  materializeConfiguredAcpEnvironmentMock,
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
  resolveConfiguredAcpBackendStartupOverridesMock,
  runHostSessionRuntimeMock,
  runHostSessionRuntimePlanMock,
} = vi.hoisted(() => ({
  buildConfiguredAcpBackendSessionMetadataMock: vi.fn(),
  createCatalogProviderAcpRuntimeMock: vi.fn(),
  createConfiguredAcpBackendMock: vi.fn(),
  materializeConfiguredAcpEnvironmentMock: vi.fn(),
  resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock: vi.fn(),
  resolveConfiguredAcpBackendStartupOverridesMock: vi.fn(),
  runHostSessionRuntimeMock: vi.fn(),
  runHostSessionRuntimePlanMock: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happy-home',
  },
}));

vi.mock('@/agent/runtime/session/loop/runHostSessionRuntime', () => ({
  runHostSessionRuntime: runHostSessionRuntimeMock,
}));

vi.mock('@/agent/runtime/session/loop/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/runtime/session/loop/lifecycle')>();
  return {
    ...actual,
    runHostSessionRuntimePlan: runHostSessionRuntimePlanMock,
  };
});

vi.mock('./resolveBackend', () => ({
  resolveConfiguredAcpBackendFromAccountSettingsOrPlugins: resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock,
}));

vi.mock('./materializeEnvironment', () => ({
  materializeConfiguredAcpEnvironment: materializeConfiguredAcpEnvironmentMock,
}));

vi.mock('@/agent/acp/runtime/createProviderAcpRuntime', () => ({
  createCatalogProviderAcpRuntime: createCatalogProviderAcpRuntimeMock,
}));

vi.mock('./createConfiguredAcpBackend', () => ({
  createConfiguredAcpBackend: createConfiguredAcpBackendMock,
}));

vi.mock('./startupOverrides', () => ({
  resolveConfiguredAcpBackendStartupOverrides: resolveConfiguredAcpBackendStartupOverridesMock,
}));

vi.mock('./sessionMetadata', () => ({
  buildConfiguredAcpBackendSessionMetadata: buildConfiguredAcpBackendSessionMetadataMock,
}));

vi.mock('@/daemon/startDaemon', () => ({
  initialMachineMetadata: {
    host: 'test-host',
    platform: 'darwin',
    happyCliVersion: '0.0.0-test',
    homeDir: '/tmp',
    happyHomeDir: '/tmp/happy',
    happyLibDir: '/tmp/happy/lib',
  },
}));

vi.mock('@/agent/runtime/formatProviderPromptErrorMessage', () => ({
  formatProviderPromptErrorMessage: () => 'prompt-error',
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('../builtIn/ui/TerminalDisplay', () => ({
  BuiltInAcpTerminalDisplay: () => null,
}));

import { runConfiguredAcpBackend } from './runConfiguredAcpBackend';

describe('runConfiguredAcpBackend', () => {
  beforeEach(() => {
    buildConfiguredAcpBackendSessionMetadataMock.mockReset();
    createCatalogProviderAcpRuntimeMock.mockReset();
    createConfiguredAcpBackendMock.mockReset();
    materializeConfiguredAcpEnvironmentMock.mockReset();
    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockReset();
    resolveConfiguredAcpBackendStartupOverridesMock.mockReset();
    runHostSessionRuntimeMock.mockReset();
    runHostSessionRuntimePlanMock.mockReset();

    resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock.mockResolvedValue({
      backendId: 'custom-backend',
      title: 'Custom Backend',
      command: 'custom-cli',
      args: ['--serve'],
      env: { TOKEN: { t: 'literal', v: 'secret' } },
      transportProfile: 'generic',
      capabilities: {},
      defaultModel: 'sonnet',
      fsEnabled: false,
      timeouts: {
        initMs: 25,
        initDelayMs: 5,
      },
      permissionModeArgv: {
        flag: '--permission-mode',
        map: {
          default: null,
          read_only: 'read-only',
        },
      },
      mcp: {
        policy: 'drop',
      },
      messageMeta: {
        enrichOutgoing: (message: unknown) => ({ message }),
      },
    });
    materializeConfiguredAcpEnvironmentMock.mockReturnValue({ TOKEN: 'secret' });
    resolveConfiguredAcpBackendStartupOverridesMock.mockReturnValue({
      sessionModeId: 'fast',
      sessionModeUpdatedAt: 123,
      modelId: 'sonnet',
      modelUpdatedAt: 456,
    });
    buildConfiguredAcpBackendSessionMetadataMock.mockReturnValue({
      acpConfiguredBackendV1: {
        updatedAt: 1,
        backendId: 'custom-backend',
        title: 'Custom Backend',
      },
    });
  });

  it('constructs a host-owned session runtime plan for configured ACP backends through the catalog ACP runtime scaffold', async () => {
    const runtime = { kind: 'configured-runtime' };
    const createdBackend = { kind: 'configured-backend' };
    createCatalogProviderAcpRuntimeMock.mockReturnValue(runtime);
    createConfiguredAcpBackendMock.mockReturnValue(createdBackend);

    await runConfiguredAcpBackend({
      credentials: { token: 'token' } as never,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
      accountSettingsContext: {
        settings: { configured: true },
      } as never,
    });

    expect(runHostSessionRuntimeMock).not.toHaveBeenCalled();
    expect(runHostSessionRuntimePlanMock).toHaveBeenCalledTimes(1);
    const plan = runHostSessionRuntimePlanMock.mock.calls[0]?.[0] as
      | {
          kind: 'hostSessionRuntimePlan';
          providerId: string;
          opts: Record<string, unknown>;
          config: {
            createSessionRuntime: (params: unknown) => unknown;
            beforeInitializeSession?: (params: { metadata: Record<string, unknown> }) => void;
          };
        }
      | undefined;
    expect(plan).toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'acp:custom-backend',
      opts: expect.objectContaining({
        backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' },
        sessionModeId: 'fast',
        sessionModeUpdatedAt: 123,
        modelId: 'sonnet',
        modelUpdatedAt: 456,
      }),
      config: expect.objectContaining({
        policyAgentId: 'acp:custom-backend',
        createSessionRuntime: expect.any(Function),
      }),
    }));
    if (!plan) {
      throw new Error('Expected host session runtime plan to be captured');
    }
    const planConfig = plan.config;
    const metadata: Record<string, unknown> = {};
    planConfig.beforeInitializeSession?.({ metadata });
    expect(metadata).toEqual(expect.objectContaining({
      acpConfiguredBackendV1: expect.objectContaining({
        backendId: 'custom-backend',
        title: 'Custom Backend',
      }),
    }));

    const createdRuntime = await planConfig.createSessionRuntime({
      directory: '/repo',
      machineId: 'machine-1',
      session: { sessionId: 'session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      setThinking: vi.fn(),
      getPermissionMode: () => 'default',
      memoryRecallGuidanceEnabled: false,
    });

    expect(createdRuntime).toEqual({
      nativeRuntime: runtime,
      operations: runtime,
    });
    expect(createCatalogProviderAcpRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'acp:custom-backend',
      loggerLabel: 'Custom BackendACP',
      directory: '/repo',
      memoryRecallGuidance: {
        enabled: false,
        machineId: 'machine-1',
      },
      createBackend: expect.any(Function),
    }));
    const runtimeArgs = createCatalogProviderAcpRuntimeMock.mock.calls[0]?.[0] as
      | {
          createBackend: (params: { permissionMode?: string }) => unknown;
        }
      | undefined;
    const createdConfiguredBackend = runtimeArgs?.createBackend({ permissionMode: 'default' });
    expect(createdConfiguredBackend).toBe(createdBackend);
    expect(createConfiguredAcpBackendMock).toHaveBeenCalledWith({
      cwd: '/repo',
      definition: expect.objectContaining({
        backendId: 'custom-backend',
        fsEnabled: false,
        timeouts: {
          initMs: 25,
          initDelayMs: 5,
        },
        permissionModeArgv: {
          flag: '--permission-mode',
          map: {
            default: null,
            read_only: 'read-only',
          },
        },
        mcp: {
          policy: 'drop',
        },
        messageMeta: expect.objectContaining({
          enrichOutgoing: expect.any(Function),
        }),
      }),
      launchEnv: { TOKEN: 'secret' },
      mcpServers: {},
      permissionHandler: expect.anything(),
      permissionMode: 'default',
    });
  });

  it('resolves configured ACP backends against the caller happyHomeDir so plugin-backed backends share the canonical registry surface', async () => {
    await runConfiguredAcpBackend({
      credentials: { token: 'token' } as never,
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'plugin-backed-backend' },
      happyHomeDir: '/tmp/caller-happy-home',
      accountSettingsContext: {
        settings: { configured: true },
      } as never,
    });

    expect(resolveConfiguredAcpBackendFromAccountSettingsOrPluginsMock).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'plugin-backed-backend',
      happyHomeDir: '/tmp/caller-happy-home',
      settings: { configured: true },
    }));
  });
});
