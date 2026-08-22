import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonRuntimeBootstrap } from './startDaemonRuntimeBootstrap';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { resolveConnectedServicesQuotasDaemonEnabled } from '../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

const sessionsHttp = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
}));
const composerMediaStageMaintenance = vi.hoisted(() => ({
  runActiveDaemonComposerMediaStageStartupMaintenance: vi.fn(async () => undefined),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => sessionsHttp);
vi.mock('@/transfers/staging/composerMediaStageStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/transfers/staging/composerMediaStageStore')>(),
  runActiveDaemonComposerMediaStageStartupMaintenance:
    composerMediaStageMaintenance.runActiveDaemonComposerMediaStageStartupMaintenance,
}));

vi.mock('../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => false),
}));
vi.mock('../connectedServices/quotas/startConnectedServiceQuotasLoop', () => ({
  startConnectedServiceQuotasLoop: vi.fn(() => ({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn() })),
}));
vi.mock('@/settings/accountSettings/warmActiveAccountSettingsSnapshot', () => ({
  warmActiveAccountSettingsSnapshotBestEffort: vi.fn(async () => true),
}));

vi.mock('../connectedServices/refresh/ConnectedServiceRefreshCoordinator', () => ({
  ConnectedServiceRefreshCoordinator: class {
    constructor(public readonly params: unknown) {}
  },
}));
vi.mock('../connectedServices/refresh/startConnectedServiceRefreshLoop', () => ({
  startConnectedServiceRefreshLoop: vi.fn(() => ({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn() })),
}));

describe('startDaemonRuntimeBootstrap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    sessionsHttp.fetchSessionByIdCompat.mockReset();
  });

  it('keeps quota automation disabled when authoritative current-source hydration fails', async () => {
    vi.mocked(resolveConnectedServicesQuotasDaemonEnabled).mockResolvedValueOnce(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const result = await startDaemonRuntimeBootstrap({
      api: {
        listConnectedServiceProfiles: async () => { throw new Error('inventory unavailable'); },
        listConnectedServiceAuthGroups: async () => [],
      } as never,
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
      logger,
      processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false' },
      controlPort: 41233,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
        applyCommittedGeneration: vi.fn(async (input) => ({ status: 'session_not_found', generation: input.generation })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
      connectedServiceQuotaFetcherDescriptors: [{
        id: 'openai-codex',
        createFetcher: () => ({ serviceId: 'openai-codex', loadQuota: async () => null }),
      }],
    });
    expect(result.connectedServiceQuotasCoordinator).toBeNull();
    expect(startConnectedServiceRefreshLoop).not.toHaveBeenCalled();
    expect(startConnectedServiceQuotasLoop).not.toHaveBeenCalled();
    expect(
      composerMediaStageMaintenance.runActiveDaemonComposerMediaStageStartupMaintenance,
    ).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('quota automation disabled'),
      expect.any(Error),
    );
  });

  it('delegates scheduler enablement to the canonical gates instead of inferring a server-wide legacy mode', async () => {
    vi.mocked(resolveConnectedServicesQuotasDaemonEnabled)
      .mockResolvedValueOnce(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    const listConnectedServiceProfiles = vi.fn(async ({ serviceId }: { serviceId: 'openai-codex' }) => ({
      serviceId,
      profiles: [],
    }));
    const getServerFeaturesSnapshot = vi.fn(async () => ({
      status: 'ready' as const,
      features: {
        features: {
          sharing: {
            pendingQueueV2: { enabled: true },
          },
        },
        capabilities: {},
      },
    }));
    const loadQuota = vi.fn();
    const result = await startDaemonRuntimeBootstrap({
      api: {
        getServerFeaturesSnapshot,
        listConnectedServiceProfiles,
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
        push: () => ({}),
      } as never,
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      processEnv: {
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'true',
      },
      controlPort: 41234,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({
          status: 'session_not_found' as const,
        })),
        applyCommittedGeneration: vi.fn(async (input) => ({
          status: 'session_not_found',
          generation: input.generation,
        })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
      connectedServiceRuntimeQuotaSnapshots:
        new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
      connectedServiceQuotaFetcherDescriptors: [{
        id: 'openai-codex',
        createFetcher: () => ({
          serviceId: 'openai-codex',
          loadQuota,
        }),
      }],
    });

    expect(result.connectedServiceRefreshCoordinator).not.toBeNull();
    expect(result.connectedServiceQuotasCoordinator).not.toBeNull();
    expect(resolveConnectedServicesQuotasDaemonEnabled).toHaveBeenCalledOnce();
    expect(getServerFeaturesSnapshot).not.toHaveBeenCalled();
    expect(startConnectedServiceRefreshLoop).toHaveBeenCalledOnce();
    expect(startConnectedServiceQuotasLoop).toHaveBeenCalledOnce();
    expect(listConnectedServiceProfiles).toHaveBeenCalled();
    expect(loadQuota).not.toHaveBeenCalled();
  });

  it('creates daemon server-work with a connection gate and logger', async () => {
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const result = await startDaemonRuntimeBootstrap({
      api: {
        listConnectedServiceProfiles: async ({ serviceId }: { serviceId: 'github' }) => ({ serviceId, profiles: [] }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
      } as never,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      logger,
      processEnv: {
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false',
      },
      controlPort: 41234,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
        applyCommittedGeneration: vi.fn(async (input) => ({ status: 'session_not_found', generation: input.generation })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
    });
    const gateHandle = result as typeof result & {
      setDaemonServerWorkOnline?: (online: boolean) => void;
    };

    expect(gateHandle.setDaemonServerWorkOnline).toEqual(expect.any(Function));
    gateHandle.setDaemonServerWorkOnline?.(false);
    const offlineRun = vi.fn(async () => {});
    await expect(result.daemonServerWorkScheduler.enqueue({
      key: 'quota-key',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: {},
      payloadBytes: 0,
      run: offlineRun,
    })).resolves.toEqual({ status: 'deferred', reason: 'offline' });
    expect(offlineRun).not.toHaveBeenCalled();

    gateHandle.setDaemonServerWorkOnline?.(true);
    const failure = new Error('write failed');
    await expect(result.daemonServerWorkScheduler.enqueue({
      key: 'quota-key-2',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: {},
      payloadBytes: 0,
      run: async () => {
        throw failure;
      },
    })).resolves.toMatchObject({
      status: 'failed',
      classification: { retryable: false },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[DAEMON SERVER WORK] Background server work failed',
      expect.objectContaining({
        purpose: 'connectedServiceQuotaPersistence',
        kind: 'latestStateWrite',
        key: 'quota-key-2',
      }),
    );
  });

  it('routes refreshed runtime credentials through the canonical session application owner', async () => {
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const applyCredentialUpdate = vi.fn(async () => ({ status: 'hot_applied' as const }));
    const authGroupCoordinator = Object.assign({
      switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
      applyCommittedGeneration: vi.fn(async (input: Readonly<{ generation: number }>) => ({
        status: 'session_not_found',
        generation: input.generation,
      })),
    }, { applyCredentialUpdate });

    const result = await startDaemonRuntimeBootstrap({
      api: { push: () => ({}), listConnectedServiceProfiles: () => ({}) } as never,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      logger,
      processEnv: {
        // Refresh enabled so the coordinator's canonical application callback is wired.
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'true',
      },
      controlPort: 41235,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: authGroupCoordinator,
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
    });

    const refreshCoordinator = result.connectedServiceRefreshCoordinator as unknown as Readonly<{
      params: Readonly<{
        onAuthUpdated(event: unknown): Promise<void>;
      }>;
    }>;
    await refreshCoordinator.params.onAuthUpdated({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{
        pid: 42,
        agentId: 'codex',
        sessionId: 'session-42',
        materializationKey: 'materialization-42',
      }],
      trigger: 'refresh_triggered_restart',
      executionAuthority: 'runtime_recovery',
    });

    expect(applyCredentialUpdate).toHaveBeenCalledWith({
      sessionId: 'session-42',
      serviceId: 'openai-codex',
      profileId: 'work',
      reason: 'account_changed',
      executionAuthority: 'runtime_recovery',
    });
  });

  it('keeps legacy-unfenced persisted identity out of same-account fanout authority', async () => {
    vi.mocked(resolveConnectedServicesQuotasDaemonEnabled).mockResolvedValueOnce(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    sessionsHttp.fetchSessionByIdCompat.mockResolvedValue({ id: 'session-1' });
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'legacy-access',
        refreshToken: 'legacy-refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'provider-account',
        providerEmail: null,
      },
    });
    const result = await startDaemonRuntimeBootstrap({
      api: {
        push: () => ({}),
        listConnectedServiceProfiles: async ({ serviceId }: { serviceId: 'openai-codex' }) => ({
          serviceId,
          profiles: [],
        }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
        getConnectedServiceCredentialPlain: vi.fn(async () => ({
          content: { t: 'plain' as const, v: record },
          revisionSemantics: 'legacy_unfenced' as const,
          credentialRevision: null,
        })),
      } as never,
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(32).fill(7),
        },
      },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
      processEnv: {
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false',
      },
      controlPort: 41237,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({
          status: 'session_not_found' as const,
        })),
        applyCommittedGeneration: vi.fn(async (input) => ({
          status: 'session_not_found',
          generation: input.generation,
        })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
      connectedServiceRuntimeQuotaSnapshots:
        new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore: createProviderAccountUsageStore(),
      connectedServiceQuotaFetcherDescriptors: [{
        id: 'openai-codex',
        createFetcher: () => ({
          serviceId: 'openai-codex',
          loadQuota: async () => null,
        }),
      }],
    });
    const fanoutReader = (result.connectedServiceQuotasCoordinator as unknown as {
      readPersistedSessionAccountIdentity(input: Readonly<{
        sessionId: string;
        serviceId: 'openai-codex';
        profileId: string;
        groupId: string;
        expectedGroupGeneration: number;
      }>): Promise<unknown>;
    }).readPersistedSessionAccountIdentity;

    await expect(fanoutReader({
      sessionId: 'session-1',
      serviceId: 'openai-codex',
      profileId: 'work',
      groupId: 'team',
      expectedGroupGeneration: 1,
    })).resolves.toBeNull();
  });

  it('wires exact live runtime identity reader into connected-service quota fanout', async () => {
    vi.mocked(resolveConnectedServicesQuotasDaemonEnabled).mockResolvedValueOnce(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const connectedServiceRuntimeAuthApplyCapabilityResolver = vi.fn(async () => ({ directLiveHotAuth: 'unsupported' as const }));
    const providerAccountUsageStore = createProviderAccountUsageStore();

    const input = {
      api: {
        listConnectedServiceProfiles: async ({ serviceId }: { serviceId: 'github' }) => ({ serviceId, profiles: [] }),
        listConnectedServiceAuthGroups: async () => [],
        resolveProviderAccountUsageSource: async () => null,
      } as never,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      logger,
      processEnv: {
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false',
      },
      controlPort: 41236,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      publishDaemonState: vi.fn(() => true),
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
        applyCommittedGeneration: vi.fn(async (input) => ({ status: 'session_not_found', generation: input.generation })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
      connectedServiceRuntimeAuthApplyCapabilityResolver,
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
      providerAccountUsageStore,
      connectedServiceQuotaFetcherDescriptors: [{
        id: 'github',
        createFetcher: () => ({
          serviceId: 'github',
          loadQuota: async () => null,
        }),
      }],
    } satisfies Parameters<typeof startDaemonRuntimeBootstrap>[0] & {
      providerAccountUsageStore: ReturnType<typeof createProviderAccountUsageStore>;
    };

    const result = await startDaemonRuntimeBootstrap(input);

    expect(logger.warn.mock.calls).toEqual([]);
    expect(result.connectedServiceQuotasCoordinator).not.toBeNull();
    expect((result.connectedServiceQuotasCoordinator as unknown as {
      readRuntimeAccountIdentityForFanout?: unknown;
    }).readRuntimeAccountIdentityForFanout).toEqual(expect.any(Function));
    expect((result.connectedServiceQuotasCoordinator as unknown as {
      runtimeAuthApplyCapabilityResolver?: unknown;
    }).runtimeAuthApplyCapabilityResolver).toBe(connectedServiceRuntimeAuthApplyCapabilityResolver);
    expect((result.connectedServiceQuotasCoordinator as unknown as {
      accountUsageStore?: unknown;
    }).accountUsageStore).toBe(providerAccountUsageStore);
    expect((result.connectedServiceQuotasCoordinator as unknown as {
      quotaFetchersByServiceId?: ReadonlyMap<string, unknown>;
    }).quotaFetchersByServiceId?.has('github')).toBe(true);
  });
});
