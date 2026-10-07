import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDaemonRuntimeBootstrap } from './startDaemonRuntimeBootstrap';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { startConnectedServiceQuotasLoop } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { startConnectedServiceRefreshLoop } from '../connectedServices/refresh/startConnectedServiceRefreshLoop';
import {
  QualifiedConnectedAccountCredentialSnapshotV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
  type QualifiedConnectedAccountServiceRef,
} from '@happier-dev/protocol';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServices/connectedServiceChildEnvironment';
import { buildConnectedServiceAuthGroupCommittedGenerationFact } from '../connectedServices/sessionAuthSwitch/connectedServiceAuthSwitchOutcome';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

const sessionsHttp = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
}));
const composerMediaStageMaintenance = vi.hoisted(() => ({
  runActiveDaemonComposerMediaStageStartupMaintenance: vi.fn(async () => undefined),
}));
const qualifiedConnectedAccountApi = vi.hoisted(() => ({
  listAccounts: vi.fn(async ({ service }: { service: QualifiedConnectedAccountServiceRef }) => ({
    service,
    accounts: [],
  })),
  listGroups: vi.fn(async () => ({ groups: [] })),
  resolveUsageSource: vi.fn(async () => null),
  readUsageRecord: vi.fn(async () => null),
  readCredential: vi.fn<typeof import('@/api/client/qualifiedConnectedAccountApi')['readQualifiedConnectedAccountCredentialV4']>(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => sessionsHttp);
vi.mock('@/transfers/staging/composerMediaStageStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/transfers/staging/composerMediaStageStore')>(),
  runActiveDaemonComposerMediaStageStartupMaintenance:
    composerMediaStageMaintenance.runActiveDaemonComposerMediaStageStartupMaintenance,
}));
vi.mock('@/api/client/qualifiedConnectedAccountApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client/qualifiedConnectedAccountApi')>()),
  listQualifiedConnectedAccountsV4: qualifiedConnectedAccountApi.listAccounts,
  listQualifiedConnectedAccountGroupsV4: qualifiedConnectedAccountApi.listGroups,
  resolveQualifiedProviderAccountUsageSourceV4: qualifiedConnectedAccountApi.resolveUsageSource,
  readQualifiedProviderAccountUsageRecordV4: qualifiedConnectedAccountApi.readUsageRecord,
  readQualifiedConnectedAccountCredentialV4: qualifiedConnectedAccountApi.readCredential,
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

function createQualifiedV4RuntimeFixture() {
  return {
    qualifiedConnectedAccountEstablishedRuntimeOwner: {
      invokeWithReceipt: vi.fn(),
    },
    resolveQualifiedConnectedAccountPeerClass: () => 'advertised_v4' as const,
    listScheduledQualifiedConnectedAccounts: async () => [],
  };
}

function stubQuotaFeatureHttp(enabled: boolean) {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== '/v1/features') throw new Error(`Unexpected HTTP request: ${url.pathname}`);
    return new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: { connectedServices: { enabled: true, quotas: { enabled } } },
      capabilities: {},
    })), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

describe('startDaemonRuntimeBootstrap', () => {
  beforeEach(() => {
    stubQuotaFeatureHttp(false);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    vi.clearAllMocks();
    sessionsHttp.fetchSessionByIdCompat.mockReset();
    qualifiedConnectedAccountApi.listAccounts.mockReset().mockImplementation(
      async ({ service }: { service: QualifiedConnectedAccountServiceRef }) => ({ service, accounts: [] }),
    );
    qualifiedConnectedAccountApi.listGroups.mockReset().mockResolvedValue({ groups: [] });
    qualifiedConnectedAccountApi.resolveUsageSource.mockReset().mockResolvedValue(null);
    qualifiedConnectedAccountApi.readUsageRecord.mockReset().mockResolvedValue(null);
    qualifiedConnectedAccountApi.readCredential.mockReset();
    vi.useRealTimers();
  });

  it('keeps quota automation disabled when authoritative current-source hydration fails', async () => {
    stubQuotaFeatureHttp(true);
    qualifiedConnectedAccountApi.listAccounts.mockRejectedValueOnce(new Error('inventory unavailable'));
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const result = await startDaemonRuntimeBootstrap({
      api: {} as never,
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
    stubQuotaFeatureHttp(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
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
      ...createQualifiedV4RuntimeFixture(),
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
    expect(getServerFeaturesSnapshot).not.toHaveBeenCalled();
    expect(startConnectedServiceRefreshLoop).toHaveBeenCalledOnce();
    expect(startConnectedServiceQuotasLoop).toHaveBeenCalledOnce();
    expect(qualifiedConnectedAccountApi.listAccounts).toHaveBeenCalled();
    expect(qualifiedConnectedAccountApi.listGroups).toHaveBeenCalled();
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
    const runtimeRegistry = new ConnectedServiceRuntimeRegistry();
    runtimeRegistry.registerTarget({
      pid: 42,
      agentId: 'codex',
      sessionId: 'session-42',
      materializationKey: 'materialization-42',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'acme.accounts/session-auth': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
    });

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
      connectedServiceRuntimeRegistry: runtimeRegistry,
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
      affectedTargets: runtimeRegistry.listRefreshTargets(),
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

  it.each(['exact', 'legacy_unfenced', 'delayed_session', 'delayed_credential', 'failed_session'] as const)('admits only exact persisted fanout proof without a guessed local cutoff (%s)', async (scenario) => {
    stubQuotaFeatureHttp(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const snapshot = QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
      ref: { service, accountId: 'work' },
      authenticationModeId: 'oauth',
      revisionSemantics: scenario === 'legacy_unfenced' ? 'legacy_unfenced' : 'revisioned',
      credentialRevision: scenario === 'legacy_unfenced' ? null : 'csr_0123456789ABCDEFGHJKMNPQRS',
      configurationRevision: null,
      content: sealQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', accountMode: 'plain',
        payload: { v: 1, values: { accessToken: 'access', refreshToken: 'refresh', providerAccountId: 'provider-account' } },
        randomBytes,
      }),
      metadata: { scopes: [], providerIdentity: { accountId: 'provider-account' } },
    });
    sessionsHttp.fetchSessionByIdCompat.mockImplementation(async () => {
      if (scenario === 'failed_session') throw new Error('session HTTP unavailable');
      if (scenario === 'delayed_session') await new Promise((resolve) => setTimeout(resolve, 3_000));
      return createSessionNotificationContextFixture('session-1');
    });
    qualifiedConnectedAccountApi.readCredential.mockImplementation(async () => {
      if (scenario === 'delayed_credential') await new Promise((resolve) => setTimeout(resolve, 3_000));
      return snapshot;
    });
    const result = await startDaemonRuntimeBootstrap({
      api: {
        push: () => ({}),
        listConnectedServiceProfiles: async ({ serviceId }: { serviceId: 'openai-codex' }) => ({
          serviceId,
          profiles: [],
        }),
        getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      } as never,
      credentials: { token: 'token', encryption: null },
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
      ...createQualifiedV4RuntimeFixture(),
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
    const coordinator = result.connectedServiceQuotasCoordinator;
    if (!coordinator) throw new Error('Expected activated quota coordinator');
    coordinator.registerSpawnTarget({
      pid: 123, sessionId: 'session-1', agentId: 'codex',
      connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'team' },
      } },
      connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group', serviceId: 'openai-codex', groupId: 'team', activeProfileId: 'work',
        fallbackProfileId: 'backup', generation: 1,
      }]) },
    });
    // Account HTTP currentness is unavailable at the live transport boundary; internal
    // identity matching and the persisted credential resolver remain real.
    const currentnessRead = vi.spyOn(await import('@/api/client/connectedServiceCredentialApi'), 'fetchAccountEncryptionCurrentness')
      .mockRejectedValue(new Error('live session transport unavailable'));
    vi.useFakeTimers();
    try {
      const serviceId = 'happier.agent.codex/openai-codex';
      const fanout = coordinator.recordAccountExhaustionAndFanout({
        sourceSessionId: 'source', serviceId, groupId: 'team', exhaustedProfileId: 'work',
        providerAccountId: 'provider-account', resetAtMs: null, reason: 'usage_limit',
        resolvedFanoutStrategy: 'provider_account_id', sourceRequiresConvergence: false,
        committedGeneration: buildConnectedServiceAuthGroupCommittedGenerationFact({
          decisionId: 'persisted-proof-test', provenance: 'hard_limit',
          decisionCommittedTarget: { serviceId, groupId: 'team', profileId: 'backup', generation: 2 },
        }),
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(fanout).resolves.toMatchObject({
        status: 'recorded', fanoutCandidates: scenario === 'exact' || scenario.startsWith('delayed_') ? 1 : 0,
      });
    } finally {
      currentnessRead.mockRestore();
      coordinator.disposeInBandQuotaPersistence();
    }
  });

  it('wires exact live runtime identity reader into connected-service quota fanout', async () => {
    stubQuotaFeatureHttp(true);
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const providerAccountUsageStore = createProviderAccountUsageStore();

    const input = {
      api: {
        listConnectedServiceProfiles: async ({ serviceId }: { serviceId: 'github' }) => ({ serviceId, profiles: [] }),
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
      ...createQualifiedV4RuntimeFixture(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
        applyCommittedGeneration: vi.fn(async (input) => ({ status: 'session_not_found', generation: input.generation })),
        applyCredentialUpdate: vi.fn(async () => ({ status: 'failed' as const, errorCode: 'session_not_found' })),
      },
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
      accountUsageStore?: unknown;
    }).accountUsageStore).toBe(providerAccountUsageStore);
    expect((result.connectedServiceQuotasCoordinator as unknown as {
      quotaFetchersByServiceId?: ReadonlyMap<string, unknown>;
    }).quotaFetchersByServiceId?.has('github')).toBe(true);
  });
});
