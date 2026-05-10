import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { VendorResumeSupportParams } from '@/backends/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

type MockEnsureSessionDirectoryResult =
  | { ok: true; directoryCreated: boolean }
  | {
      ok: false;
      response: {
        type: string;
        errorCode: string;
        errorMessage: string;
      };
    };

const hoisted = vi.hoisted(() => {
  const vendorResumeSupport = vi.fn((_: VendorResumeSupportParams) => false);
  const resolveSpawnBackendIdentity = vi.fn();
  const getVendorResumeSupport = vi.fn(async () => vendorResumeSupport);
  const requireCatalogEntry = vi.fn();
  const refreshAccountSettingsForMinimumVersion = vi.fn();
  const ensureSessionDirectory = vi.fn<() => Promise<MockEnsureSessionDirectoryResult>>(async () => ({
    ok: false,
    response: {
      type: 'error',
      errorCode: 'directory_setup_failed',
      errorMessage: 'Directory setup failed.',
    },
  }));

  return {
    vendorResumeSupport,
    resolveSpawnBackendIdentity,
    getVendorResumeSupport,
    requireCatalogEntry,
    refreshAccountSettingsForMinimumVersion,
    ensureSessionDirectory,
  };
});

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

vi.mock('@/backends/catalog', () => ({
  getVendorResumeSupport: hoisted.getVendorResumeSupport,
  requireCatalogEntry: hoisted.requireCatalogEntry,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    happyHomeDir: '/tmp/happier-home',
    activeServerDir: '/tmp/happier-home/servers/active',
  },
}));

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: hoisted.refreshAccountSettingsForMinimumVersion,
}));

vi.mock('@/agent/runtime/daemonInitialPrompt', () => ({
  HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY: 'HAPPIER_DAEMON_INITIAL_PROMPT',
  normalizeDaemonInitialPrompt: (value: unknown) => (typeof value === 'string' ? value : null),
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
  resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
  validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('@/session/backendTargets/resolveConcreteBackendTargetRefs', () => ({
  resolveConcreteBackendTargetRefV2: vi.fn(),
}));

vi.mock('../spawn/resolveSpawnBackendIdentity', () => ({
  resolveSpawnBackendIdentity: hoisted.resolveSpawnBackendIdentity,
}));

vi.mock('../spawn/resolveSpawnChildEnvironment', () => ({
  resolveSpawnChildEnvironment: vi.fn(),
}));

vi.mock('../spawn/resolveStackProcessKindOverrideForSessionSpawn', () => ({
  resolveStackProcessKindOverrideForSessionSpawn: vi.fn(),
}));

vi.mock('../spawn/createSpawnLifecycleCallbacks', () => ({
  createSpawnLifecycleCallbacks: vi.fn(),
}));

vi.mock('../spawn/routeSpawnModeAndWaitForWebhook', () => ({
  routeSpawnModeAndWaitForWebhook: vi.fn(),
}));

vi.mock('../spawn/resolveSpawnBackendIdentity', () => ({
  resolveSpawnBackendIdentity: hoisted.resolveSpawnBackendIdentity,
}));

vi.mock('../connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
  resolveConnectedServiceAuthForSpawn: vi.fn(),
}));

vi.mock('../connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
  shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./ensureSessionDirectory', () => ({
  ensureSessionDirectory: hoisted.ensureSessionDirectory,
}));

vi.mock('../sessionAttachFile', () => ({
  createSessionAttachFile: vi.fn(),
}));

vi.mock('../processSupervision/sessionRunnerRespawnDescriptor', () => ({
  SessionRunnerRespawnDescriptorV1Schema: z.any(),
  buildTrackedSessionRespawnEnvironmentVariables: vi.fn(),
}));

function createParams() {
  return {
    options: {
      directory: '/tmp/project',
      sessionId: 'session-1',
      resume: 'vendor-session-1',
      experimentalCodexAcp: true,
    },
    credentials: {
      token: 'token-1',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3]),
      },
    },
    api: {} as never,
    loadLocalHandoffMetadataByVendorResumeId: vi.fn(),
    connectedServicesMaterializationBaseDir: '/tmp/connected-services',
    connectedServiceRefreshCoordinator: null,
    connectedServiceQuotasCoordinator: null,
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'tracked-session-1'),
    onChildExited: vi.fn(),
    spawnResourceCleanupByPid: new Map(),
    sessionAttachCleanupByPid: new Map(),
    processEnv: {},
  } as const;
}

describe('executeSpawnSessionRequest', () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.vendorResumeSupport.mockReset();
    hoisted.resolveSpawnBackendIdentity.mockReset();
    hoisted.getVendorResumeSupport.mockClear();
    hoisted.requireCatalogEntry.mockReset();
    hoisted.refreshAccountSettingsForMinimumVersion.mockReset();
    hoisted.ensureSessionDirectory.mockClear();
    hoisted.getVendorResumeSupport.mockResolvedValue(hoisted.vendorResumeSupport);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValue({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: 'vendor-session-1',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.refreshAccountSettingsForMinimumVersion.mockResolvedValue(null);
  });

  it('uses account settings version hints only for daemon freshness refresh', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'codex',
    });
    hoisted.refreshAccountSettingsForMinimumVersion.mockResolvedValueOnce(null);
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });
    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
        accountSettingsVersionHint: 42,
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(hoisted.ensureSessionDirectory).toHaveBeenCalled();
    expect(hoisted.refreshAccountSettingsForMinimumVersion).toHaveBeenCalledWith(expect.objectContaining({
      minSettingsVersion: 42,
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.not.objectContaining({
      accountSettingsVersionHint: expect.any(Number),
    }));
  });

  it('canonicalizes legacy runtime descriptors before backend-owned vendor resume hooks read spawn runtime selection', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
      getDaemonSpawnHooks: async () => ({
        resolveVendorResumeSupportParams: ({ options }: {
          options: {
            codexBackendMode?: 'acp' | 'mcp' | 'appServer';
            runtimeDescriptorV1?: unknown;
            agentRuntimeDescriptorV1?: unknown;
          };
        }) => {
          expect(options).toMatchObject({
            codexBackendMode: 'appServer',
            runtimeDescriptorV1: {
              v: 1,
              providerId: 'codex',
              provider: {
                backendMode: 'appServer',
                vendorSessionId: 'legacy-thread',
              },
            },
          });
          expect(options).not.toHaveProperty('agentRuntimeDescriptorV1');
          return { codexBackendMode: 'appServer' };
        },
      }),
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => params.codexBackendMode === 'appServer');

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const baseParams = createParams();

    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        experimentalCodexAcp: undefined,
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'legacy-thread',
          },
        },
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith({ codexBackendMode: 'appServer' });
    expect(result).not.toEqual(
      expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      }),
    );
  });

  it('delegates legacy codex resume compat through backend-owned daemon spawn hooks', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
      getDaemonSpawnHooks: async () => ({
        resolveVendorResumeSupportParams: () => ({ codexBackendMode: 'appServer' }),
      }),
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => params.codexBackendMode === 'appServer');

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const result = await executeSpawnSessionRequest(createParams());

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith({ codexBackendMode: 'appServer' });
    expect(result).not.toEqual(
      expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      }),
    );
  });

	  it('fails fast for macOS background-service spawns targeting protected home directories', async () => {
	    if (!ORIGINAL_PLATFORM_DESCRIPTOR) {
	      throw new Error('Expected process.platform to be configurable for this test');
	    }
	    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });

    const startupSourceOriginal = process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
    const homeOriginal = process.env.HOME;
    process.env.HAPPIER_DAEMON_STARTUP_SOURCE = 'background-service';
    process.env.HOME = '/Users/tester';

	    try {
	      hoisted.requireCatalogEntry.mockReturnValue({
	        id: 'codex',
	        vendorResumeSupport: 'experimental',
	      });
	      hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
	        ok: true,
	        normalizedExistingSessionId: '',
	        effectiveResume: '',
	        effectiveBackendTargetV2: {
	          sourceKind: 'built_in',
	          backendId: 'codex',
	        },
	        sessionAttachPayload: null,
	        catalogAgentId: 'codex',
	      });
	      hoisted.ensureSessionDirectory.mockImplementationOnce(
	        async () => ({ ok: true, directoryCreated: false } as const),
	      );

      const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

      const result = await executeSpawnSessionRequest({
        ...createParams(),
        options: {
          ...createParams().options,
          directory: '/Users/tester/Documents/project',
          resume: undefined,
        },
      });

      expect(result).toEqual({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: expect.stringContaining('background-service'),
      });
      expect(String((result as { errorMessage?: string }).errorMessage ?? '')).toContain('/Users/tester/Documents/project');
    } finally {
      if (startupSourceOriginal === undefined) {
        delete process.env.HAPPIER_DAEMON_STARTUP_SOURCE;
      } else {
        process.env.HAPPIER_DAEMON_STARTUP_SOURCE = startupSourceOriginal;
      }
      if (homeOriginal === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = homeOriginal;
      }
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('does not synthesize codex resume compat params when the backend exposes no daemon spawn hook', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => {
      expect(params).toEqual({});
      return false;
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const result = await executeSpawnSessionRequest(createParams());

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith({});
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      errorMessage: "Resume is not supported for agent 'codex' (experimental and not enabled).",
    });
  });
});
