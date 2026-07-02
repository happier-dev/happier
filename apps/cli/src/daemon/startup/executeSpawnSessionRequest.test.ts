import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  isConnectedServiceUxDiagnosticSpawnErrorDetail,
} from '@happier-dev/protocol';
import type { VendorResumeSupportParams } from '@/backends/types';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
  'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

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
    activeServerId: 'dev-local',
    serverUrl: 'http://dev-public.example.test',
    apiServerUrl: 'http://127.0.0.1:53288',
    publicServerUrl: 'http://dev-public.example.test',
    webappUrl: 'http://dev-web.example.test',
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

vi.mock('../connectedServices/resolveConnectedServiceAuthForSpawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../connectedServices/resolveConnectedServiceAuthForSpawn')>();
  return {
    ...actual,
    resolveConnectedServiceAuthForSpawn: vi.fn(),
  };
});

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
    connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
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
    const { createSessionAttachFile } = await import('../sessionAttachFile');
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
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
    }));
  });

  it('injects daemon-owned server selection into spawned session child env', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
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
      extraEnvForChild: {
        HAPPIER_HOME_DIR: '/tmp/stale-home',
        HAPPIER_ACTIVE_SERVER_ID: 'stale-server',
        HAPPIER_SERVER_URL: 'http://stale-public.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:52753',
        HAPPIER_PUBLIC_SERVER_URL: 'http://stale-public.example.test',
        HAPPIER_WEBAPP_URL: 'http://stale-web.example.test',
      },
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
      },
      processEnv: {},
    });

    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      extraEnvForChildWithMessage: expect.objectContaining({
        HAPPIER_HOME_DIR: '/tmp/happier-home',
        HAPPIER_ACTIVE_SERVER_ID: 'dev-local',
        HAPPIER_SERVER_URL: 'http://dev-public.example.test',
        HAPPIER_LOCAL_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_PUBLIC_SERVER_URL: 'http://dev-public.example.test',
        HAPPIER_WEBAPP_URL: 'http://dev-web.example.test',
      }),
    }));
  });

  it('uses an explicit initial transcript cursor only for the attach payload', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'session-1',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );
    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-attach.json',
      cleanup: vi.fn(),
    });
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
        existingSessionId: 'session-1',
        initialTranscriptAfterSeq: 36,
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(createSessionAttachFile).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'session-1',
      payload: expect.objectContaining({
        encryptionMode: 'plain',
        lastObservedMessageSeq: 36,
        initialTranscriptAfterSeq: 36,
      }),
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.not.objectContaining({
        initialTranscriptAfterSeq: expect.any(Number),
      }),
    }));
  });

  it('passes connected-service child selections into the spawn lifecycle wiring', async () => {
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
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: '[{"kind":"group","serviceId":"openai-codex"}]',
      },
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        ...createParams().options,
        resume: undefined,
      },
    });

    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      connectedServiceSelectionsEnvRaw: '[{"kind":"group","serviceId":"openai-codex"}]',
    }));
  });

  it('uses one generated connected-service materialization identity for first-spawn materialization and tracked re-entry state', async () => {
    const ambientMaterializationIdentity = {
      v: 1,
      id: 'csm_ambient_daemon_process_env',
      createdAt: 123,
      source: 'daemon_process_env',
    };
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
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { buildTrackedSessionRespawnEnvironmentVariables } = await import('../processSupervision/sessionRunnerRespawnDescriptor');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReturnValueOnce({});
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'work',
            },
          },
        },
      },
      processEnv: {
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]:
          JSON.stringify(ambientMaterializationIdentity),
      },
    });

    const materializationKey = vi.mocked(resolveConnectedServiceAuthForSpawn).mock.calls[0]?.[0].materializationKey;
    expect(materializationKey).toEqual(expect.stringMatching(/^csm_/));
    expect(materializationKey).not.toBe(ambientMaterializationIdentity.id);
    expect(materializationKey).not.toEqual(expect.stringMatching(/^spawn-/));
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: expect.objectContaining({
          id: materializationKey,
          source: 'first_spawn',
        }),
      }),
    }));
    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      materializationKey,
    }));
    expect(buildTrackedSessionRespawnEnvironmentVariables).toHaveBeenCalledWith(expect.objectContaining({
      extraEnvForChild: expect.objectContaining({
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: expect.stringContaining(String(materializationKey)),
      }),
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: expect.objectContaining({
          id: materializationKey,
        }),
      }),
      extraEnvForChildWithMessage: expect.objectContaining({
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: expect.stringContaining(String(materializationKey)),
      }),
    }));
  });

  it('propagates canonicalized connected-service group bindings into the spawn environment and tracked state', async () => {
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
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSpawnLifecycleCallbacks } = await import('../spawn/createSpawnLifecycleCallbacks');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { buildTrackedSessionRespawnEnvironmentVariables } = await import('../processSupervision/sessionRunnerRespawnDescriptor');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(buildTrackedSessionRespawnEnvironmentVariables).mockReturnValueOnce({});
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'we-are',
            },
          },
        },
      },
    });

    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      }),
    }));
    expect(createSpawnLifecycleCallbacks).toHaveBeenCalledWith(expect.objectContaining({
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'happier',
            profileId: 'codex4',
          },
        },
      },
    }));
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'group',
              groupId: 'happier',
              profileId: 'codex4',
            },
          },
        },
      }),
    }));
  });

  it('uses a daemon-certified materialization identity repair for existing connected-service spawns', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.vendorResumeSupport.mockReturnValue(true);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'sess-claude-repair',
      effectiveResume: 'claude-vendor-session-1',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { createSessionAttachFile } = await import('../sessionAttachFile');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { resolveSpawnChildEnvironment } = await import('../spawn/resolveSpawnChildEnvironment');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(createSessionAttachFile).mockResolvedValueOnce({
      filePath: '/tmp/session-attach.json',
      cleanup: vi.fn(),
    });
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockResolvedValueOnce({
      env: {},
      cleanupOnFailure: null,
      cleanupOnExit: null,
      connectedServicesBindings: { v: 1, bindingsByServiceId: {} },
    });
    vi.mocked(resolveSpawnChildEnvironment).mockResolvedValueOnce({
      ok: true,
      cleanupOnFailure: null,
      cleanupOnExit: null,
      expandedEnvironmentVariables: {},
      extraEnvForChild: {},
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'sess-claude-repair',
    });
    const repairedIdentity = {
      v: 1 as const,
      id: 'csm_repaired_claude',
      createdAt: 123,
      source: 'first_spawn',
    };
    const repairMissingConnectedServiceMaterializationIdentityForSpawn = vi.fn(async () => repairedIdentity);

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        existingSessionId: 'sess-claude-repair',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'claude-work',
            },
          },
        },
      },
      repairMissingConnectedServiceMaterializationIdentityForSpawn,
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'sess-claude-repair',
    });
    expect(repairMissingConnectedServiceMaterializationIdentityForSpawn).toHaveBeenCalledWith({
      sessionId: 'sess-claude-repair',
      agentId: 'claude',
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'claude-subscription': {
            source: 'connected',
            selection: 'profile',
            profileId: 'claude-work',
          },
        },
      },
      vendorResumeId: 'claude-vendor-session-1',
    });
    expect(resolveConnectedServiceAuthForSpawn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-claude-repair',
      materializationKey: repairedIdentity.id,
    }));
    expect(resolveSpawnChildEnvironment).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        connectedServiceMaterializationIdentityV1: repairedIdentity,
      }),
    }));
  });

  it('returns a structured connected-service ux diagnostic when an existing connected-service spawn has no materialization identity', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.vendorResumeSupport.mockReturnValue(true);
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: 'sess-missing-identity',
      effectiveResume: 'codex-vendor-session-1',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'codex',
      },
      sessionAttachPayload: { v: 2, encryptionMode: 'plain' },
      catalogAgentId: 'codex',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockClear();

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        existingSessionId: 'sess-missing-identity',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex-work',
            },
          },
        },
      },
      repairMissingConnectedServiceMaterializationIdentityForSpawn: vi.fn(async () => null),
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
    });
    if (result.type !== 'error') throw new Error('expected spawn error');
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service ux diagnostic detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceMaterializationIdentityMissing,
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'codex',
      retryable: false,
      diagnostics: {
        reason: 'missing_identity_and_resume_state',
      },
    });
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('returns a structured connected-service ux diagnostic when connected-service materialization is blocked before spawn', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
    hoisted.ensureSessionDirectory.mockImplementationOnce(
      async () => ({ ok: true, directoryCreated: false }),
    );

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');
    const { resolveConnectedServiceAuthForSpawn } = await import('../connectedServices/resolveConnectedServiceAuthForSpawn');
    const { shouldResolveConnectedServiceAuthForSpawn } = await import('../connectedServices/shouldResolveConnectedServiceAuthForSpawn');
    const { routeSpawnModeAndWaitForWebhook } = await import('../spawn/routeSpawnModeAndWaitForWebhook');
    const { ConnectedServiceMaterializationBlockedError } = await import('../connectedServices/materialize/materializeConnectedServicesForSpawn');
    vi.mocked(shouldResolveConnectedServiceAuthForSpawn).mockReturnValue(true);
    vi.mocked(resolveConnectedServiceAuthForSpawn).mockRejectedValueOnce(
      new ConnectedServiceMaterializationBlockedError([{
        code: 'claude_subscription_missing_claude_code_scope',
        providerId: 'claude',
        serviceId: 'claude-subscription',
        severity: 'blocking',
        reason: 'missing_required_scope',
        entryName: 'user:sessions:claude_code',
      }]),
    );

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': {
              source: 'connected',
              selection: 'profile',
              profileId: 'claude-work',
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: 'claude_subscription_missing_claude_code_scope',
    });
    if (result.type !== 'error') throw new Error('expected spawn error');
    expect(isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)).toBe(true);
    if (!isConnectedServiceUxDiagnosticSpawnErrorDetail(result.errorDetail)) {
      throw new Error('expected connected-service ux diagnostic detail');
    }
    expect(result.errorDetail.uxDiagnostic).toMatchObject({
      code: 'claude_subscription_missing_claude_code_scope',
      failurePhase: 'materialization',
      source: 'spawn_resume',
      agentId: 'claude',
      providerId: 'claude',
      serviceId: 'claude-subscription',
      retryable: false,
      diagnostics: {
        reason: 'missing_required_scope',
        materializationCode: 'claude_subscription_missing_claude_code_scope',
        entryName: 'user:sessions:claude_code',
      },
    });
    expect(routeSpawnModeAndWaitForWebhook).not.toHaveBeenCalled();
  });

  it('tracks connected-service materialization diagnostics on tracked spawn options for downstream switch surfaces', async () => {
    const diagnostics = [{
      code: 'state_sharing_degraded',
      providerId: 'claude',
      serviceId: 'anthropic',
      requestedStateMode: 'shared',
      effectiveStateMode: 'isolated',
      reason: 'provider_state_unavailable',
    }] as const;
    hoisted.requireCatalogEntry.mockReturnValue({});
    hoisted.resolveSpawnBackendIdentity.mockResolvedValueOnce({
      ok: true,
      normalizedExistingSessionId: '',
      effectiveResume: '',
      effectiveBackendTargetV2: {
        sourceKind: 'built_in',
        backendId: 'claude',
      },
      sessionAttachPayload: null,
      catalogAgentId: 'claude',
    });
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
      materializationDiagnostics: diagnostics,
    });
    vi.mocked(routeSpawnModeAndWaitForWebhook).mockResolvedValueOnce({
      type: 'success',
      sessionId: 'session-1',
    });

    const result = await executeSpawnSessionRequest({
      ...createParams(),
      options: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
    });

    expect(result).toEqual({
      type: 'success',
      sessionId: 'session-1',
    });
    expect(routeSpawnModeAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      trackedSpawnOptions: expect.objectContaining({
        materializationDiagnostics: diagnostics,
      }),
    }));
  });

  it('canonicalizes legacy runtime descriptors before vendor resume support reads spawn runtime selection', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams & {
      runtimeDescriptorV1?: unknown;
      agentRuntimeDescriptorV1?: unknown;
    }) => {
      expect(params).toMatchObject({
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'legacy-thread',
          },
        },
      });
      expect(params).not.toHaveProperty('agentRuntimeDescriptorV1');
      return params.codexBackendMode === 'appServer';
    });

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
            providerSessionId: 'legacy-thread',
          },
        },
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith(expect.objectContaining({ codexBackendMode: 'appServer' }));
    expect(result).not.toEqual(
      expect.objectContaining({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      }),
    );
  });

  it('delegates legacy codex resume compat through canonical spawn runtime selection without daemon hooks', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => params.codexBackendMode === 'appServer');

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const baseParams = createParams();
    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        codexBackendMode: 'appServer',
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith(expect.objectContaining({ codexBackendMode: 'appServer' }));
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

  it('does not synthesize codex resume compat params when no canonical runtime selection exists', async () => {
    hoisted.requireCatalogEntry.mockReturnValue({
      id: 'codex',
      vendorResumeSupport: 'experimental',
    });
    hoisted.vendorResumeSupport.mockImplementation((params: VendorResumeSupportParams) => {
      expect(params).toEqual({});
      return false;
    });

    const { executeSpawnSessionRequest } = await import('./executeSpawnSessionRequest');

    const baseParams = createParams();
    const result = await executeSpawnSessionRequest({
      ...baseParams,
      options: {
        ...baseParams.options,
        experimentalCodexAcp: undefined,
      },
    });

    expect(hoisted.vendorResumeSupport).toHaveBeenCalledWith({});
    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
      errorMessage: "Resume is not supported for agent 'codex' (experimental and not enabled).",
    });
  });
});
