import { readFile } from 'node:fs/promises';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FeaturesResponseSchema,
  ExternalSessionAttachResponseSchema,
  ExternalSessionFollowPolicySetResponseSchema,
  ExternalSessionLinkEnsureResponseSchema,
  ExternalSessionMaterializeStartInputV1Schema,
  ExternalSessionOperationActionResponseV1Schema,
  ExternalSessionOperationTransportReferenceV1Schema,
  ExternalSessionStatusGetResponseSchema,
  ExternalSessionTakeoverPersistResponseSchema,
  ExternalSessionTakeoverResponseSchema,
  ExternalSessionsCandidatesListResponseSchema,
  ExternalSessionTranscriptPageResponseSchema,
  ExternalSessionTranscriptReadAfterResponseSchema,
} from '@happier-dev/protocol';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import type { ExternalSessionHostOperationSet } from '@/session/external/hostOperationOwner';
import type {
  startExternalSessionPassiveObservation,
} from '@/api/session/external/leases/startExternalSessionPassiveObservation';

const {
  observationProjectionParams,
  fixtureCredentials,
  readStoredCredentialsMock,
  writeFollowStatusMock,
} = vi.hoisted(() => {
  return {
    observationProjectionParams: {
      current: null as unknown,
    },
    fixtureCredentials: { current: false },
    readStoredCredentialsMock: vi.fn(),
    writeFollowStatusMock: vi.fn(async (_input: unknown) => {}),
  };
});

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: () => readStoredCredentialsMock(),
    readStoredCredentials: () => readStoredCredentialsMock(),
  };
});

vi.mock('@/api/session/external/leases/createExternalSessionObservationDaemonProjection', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection')
  >();
  return {
    ...actual,
    createExternalSessionObservationDaemonProjection: (
      params: Parameters<typeof actual.createExternalSessionObservationDaemonProjection>[0],
    ) => {
      observationProjectionParams.current = params;
      return actual.createExternalSessionObservationDaemonProjection(params);
    },
  };
});

vi.mock('@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata', () => ({
  writeExternalSessionFollowStatus: (input: unknown) => writeFollowStatusMock(input),
}));

import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';

const MATERIALIZE_START_TRANSPORT_INPUT = ExternalSessionMaterializeStartInputV1Schema.parse({
  request: {
    v: 1,
    idempotencyKey: 'materialize-1',
    sessionId: 'linked-session-1',
    plan: 'materialize',
    targetStorageMode: 'external-linked',
    targetRuntimeMode: null,
  },
});

const OPERATION_REFERENCE_TRANSPORT_INPUT = ExternalSessionOperationTransportReferenceV1Schema.parse({
  sessionId: 'linked-session-1',
  operationId: 'operation-1',
  revision: 0,
});

const TAKEOVER_START_TRANSPORT_INPUT = {
  request: {
    v: 1,
    idempotencyKey: 'takeover-1',
    sessionId: 'linked-session-1',
    source: {
      machineId: 'machine-1',
      remoteSessionId: 'remote-session-1',
      qualifiedIdentity: {
        v: 1,
        agent: {
          pluginId: 'acme.external',
          localId: 'agent',
        },
        source: {
          kind: 'source',
          contractVersion: 1,
        },
      },
      linkGeneration: 'link-generation-1',
    },
    plan: 'takeover',
    targetStorageMode: 'persisted',
    targetDirectory: '/local/selected/workspace',
    targetRuntimeMode: 'terminal',
  },
};

function createRpcHandlerManager(): { handlers: Map<string, (params: unknown) => Promise<unknown>>; registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => void } {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

function createServerFeaturesSnapshot(
  currentPublicationFenceVersion?: number,
): CliServerFeaturesSnapshot {
  const features = FeaturesResponseSchema.parse({
    features: {},
    capabilities: {},
  });
  return {
    status: 'ready',
    features: currentPublicationFenceVersion === undefined
      ? features
      : {
      ...features,
      capabilities: {
        ...features.capabilities,
        session: {
          ...features.capabilities.session,
          externalImport: {
            publicationFenceVersion: currentPublicationFenceVersion,
          },
        },
      },
    },
  };
}

describe('registerMachineExternalSessionsRpcHandlers execution-surface seam', () => {
  afterAll(async () => {
    await pluginReloadController.shutdown();
  });

  beforeEach(() => {
    observationProjectionParams.current = null;
    fixtureCredentials.current = false;
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockImplementation(async () => fixtureCredentials.current
      ? { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array() } }
      : null);
    writeFollowStatusMock.mockReset();
    writeFollowStatusMock.mockResolvedValue(undefined);
  });

  it.each([
    { sessionId: 'session-follow-admission', enabled: false },
    { sessionId: 'session-follow-admission', enabled: false, machineId: 'machine-1', agentId: 'codex',
      remoteSessionId: 'native-session', source: { kind: 'codexHome', home: '/tmp/follow-home' } },
    // Constructed from cli-v0.2.17 (a2c45c86804b24e60ac0b76146a3ef36dfcaa15b),
    // packages/protocol/src/directSessions/daemonRpcV1.ts: DirectSessionFollowPolicySetRequestSchema.
    { sessionId: 'session-follow-admission', enabled: false, machineId: 'machine-1', providerId: 'codex',
      remoteSessionId: 'native-session', source: { kind: 'codexHome', home: '/tmp/follow-home' } },
  ])('admits follow intent through real Machine registration before credential refusal: %j', async (request) => {
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      // The transport boundary records callbacks; registration and admission stay real.
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-1',
    });
    try {
      readStoredCredentialsMock.mockClear();
      await expect(rpcHandlerManager.handlers.get(
        RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
      )?.(request)).resolves.toMatchObject({
        ok: false, errorCode: 'agent_unavailable', error: 'not_authenticated',
      });
      expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
    } finally {
      await registration.dispose();
    }
  });

  it.each([
    { enabled: false },
    { sessionId: 'session-follow-admission', enabled: false, agentId: 'codex' },
    { sessionId: 'session-follow-admission', enabled: false, machineId: 'other-machine' },
  ])('refuses missing or partial captured identity before follow admission: %j', async (request) => {
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      // The transport boundary records callbacks; registration and admission stay real.
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-1',
    });
    try {
      readStoredCredentialsMock.mockClear();
      await expect(rpcHandlerManager.handlers.get(
        RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
      )?.(request)).resolves.toMatchObject({
        ok: false, errorCode: 'invalid_action_transport_input',
      });
      expect(readStoredCredentialsMock).not.toHaveBeenCalled();
    } finally {
      await registration.dispose();
    }
  });

  it('injects daemon device-local custody into secure transcript read-after validation', async () => {
    const deviceLocalSecretStorage = {
      sealJson: vi.fn(() => 'sealed'),
      openJson: vi.fn(() => null),
      deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
    } as never;
    const binding = {
      v: 1 as const,
      machineId: 'machine-1',
      sessionId: 'session-1',
      link: {
        generation: 'link-1',
        remoteSessionId: 'remote-1',
      },
      source: {
        qualifiedIdentity: {
          v: 1 as const,
          agent: {
            pluginId: 'happier.codex',
            localId: 'codex',
          },
          source: {
            kind: 'codexHome',
            contractVersion: 1 as const,
          },
        },
        generation: 'source-1',
      },
      sourceCustody: { kind: 'development', registeredRootId: 'plugin-1' },
      cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
    };
    const cursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      deviceLocalSecretStorage,
    });
    readStoredCredentialsMock.mockClear();

    const handler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
    );
    await expect(handler?.({
      v: 1,
      binding,
      cursor,
    })).resolves.toEqual({
      v: 1,
      binding,
      result: { outcome: 'source_unavailable' },
    });
    expect(readStoredCredentialsMock).toHaveBeenCalledOnce();

    readStoredCredentialsMock.mockClear();
    const noCustodyRpc = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: noCustodyRpc as never });
    readStoredCredentialsMock.mockClear();
    await expect(noCustodyRpc.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER)?.({
      v: 1,
      binding,
      cursor,
    })).resolves.toEqual({ v: 1, binding, result: { outcome: 'source_unavailable' } });
    expect(readStoredCredentialsMock).not.toHaveBeenCalled();
  });

  it('installs and retires daemon-scoped host operations with machine RPC composition', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    const disposeInstallation = vi.fn(async () => undefined);
    let capturedOperations: ExternalSessionHostOperationSet | null = null;
    const installExternalSessionHostOperations = vi.fn(async (
      operations: ExternalSessionHostOperationSet,
    ) => {
      capturedOperations = operations;
      return { dispose: disposeInstallation };
    });
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      spawnSession: async () => ({ type: 'success', sessionId: 'session-1' }),
      stopSession: async () => true,
      machineId: 'machine-1',
      installExternalSessionHostOperations,
    });

    expect(installExternalSessionHostOperations).toHaveBeenCalledOnce();
    expect(capturedOperations).toMatchObject({
      followTargetOperation: { execute: expect.any(Function) },
      followOperation: { execute: expect.any(Function) },
    });
    await registration.dispose();
    expect(disposeInstallation).toHaveBeenCalledOnce();
  });

  it('continues composed daemon teardown after an earlier owner fails and returns a sanitized aggregate', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    const cleanupOrder: string[] = [];
    let hostOperationsDisposed = false;
    const detachPersistedTakeoverAdmissionOwner = vi.fn(() => {
      cleanupOrder.push('persisted_takeover_admission_owner');
      throw new Error('persisted-takeover-private-cleanup-failure');
    });
    const disposeInstallation = vi.fn(async () => {
      cleanupOrder.push('host_operations');
      await Promise.resolve();
      hostOperationsDisposed = true;
    });
    const detachSessionArchivedStateChanges = vi.fn(() => {
      cleanupOrder.push('session_archived_state_changes');
      expect(hostOperationsDisposed).toBe(true);
    });
    const detachDemand = vi.fn(() => {
      cleanupOrder.push('status_demand_binding');
    });
    const detachConnection = vi.fn(() => {
      cleanupOrder.push('status_demand_connection');
    });
    const disposePassiveObservation = vi.fn(async () => {
      cleanupOrder.push('passive_observation');
    });
    const releaseFollowLease = vi.fn(async () => {
      cleanupOrder.push('follow_lease_manager');
    });
    const captured: {
      followLeaseManager:
        Parameters<typeof startExternalSessionPassiveObservation>[0]['followLeaseManager']
        | null;
    } = { followLeaseManager: null };
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      executeExternalSessionHistoricalImportCommand: async () => ({
        v: 1,
        kind: 'error',
        errorCode: 'upgrade_required',
        message: 'not-used-by-cleanup-test',
      }),
      persistedTakeoverAdmissionWaiter: {} as never,
      attachPersistedTakeoverAdmissionOwner: () => detachPersistedTakeoverAdmissionOwner,
      installExternalSessionHostOperations: async () => ({ dispose: disposeInstallation }),
      statusDemand: {
        machineId: 'machine-1',
        channel: {
          onExternalSessionStatusDemand: () => detachDemand,
          onConnectionStateChange: () => detachConnection,
        },
      },
      startPassiveObservation: (input) => {
        captured.followLeaseManager = input.followLeaseManager;
        return {
          ready: Promise.resolve(),
          pause: async () => {},
          resume: async () => {},
          reconcileSession: async () => ({ status: 'settled' as const }),
          releaseSession: async () => {},
          dispose: disposePassiveObservation,
        };
      },
      subscribeSessionArchivedStateChanges: () => detachSessionArchivedStateChanges,
    });
    const followLeaseManager = captured.followLeaseManager;
    if (!followLeaseManager) throw new Error('Expected follow lease manager');

    await followLeaseManager.setBackgroundFollowEnabled({
      sessionId: 'session-1',
      enabled: true,
      acquireFollowLease: async () => ({ release: releaseFollowLease }),
    });

    const failure = await registration.dispose().then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(String((failure as AggregateError).errors[0])).toContain(
      'external_session_daemon_cleanup_failed:persisted_takeover_admission_owner',
    );
    expect(String(failure)).not.toContain('persisted-takeover-private-cleanup-failure');
    expect(disposeInstallation).toHaveBeenCalledOnce();
    expect(detachSessionArchivedStateChanges).toHaveBeenCalledOnce();
    expect(detachDemand).toHaveBeenCalledOnce();
    expect(detachConnection).toHaveBeenCalledOnce();
    expect(disposePassiveObservation).toHaveBeenCalledOnce();
    expect(releaseFollowLease).toHaveBeenCalledOnce();
    expect(cleanupOrder).toEqual([
      'persisted_takeover_admission_owner',
      'host_operations',
      'session_archived_state_changes',
      'status_demand_binding',
      'status_demand_connection',
      'passive_observation',
      'follow_lease_manager',
    ]);
  });

  it('owns the status-demand channel subscription and detaches it with the projection lifecycle', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    const detachDemand = vi.fn();
    const detachConnection = vi.fn();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      statusDemand: {
        machineId: 'machine-1',
        channel: {
          onExternalSessionStatusDemand: () => detachDemand,
          onConnectionStateChange: () => detachConnection,
        },
      },
    });

    await registration.dispose();

    expect(detachDemand).toHaveBeenCalledOnce();
    expect(detachConnection).toHaveBeenCalledOnce();
  });

  it('allows ready notifications only for explicit background follow with no attached viewer', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    let followLeaseManager: unknown = null;
    type FollowLeaseManagerFixture = Readonly<{
      attach(input: Readonly<{
        sessionId: string;
        ttlMs: number;
      }>): Promise<Readonly<{ leaseId: string }>>;
      detach(input: Readonly<{
        sessionId: string;
        leaseId: string;
      }>): Promise<unknown>;
      setBackgroundFollowEnabled(input: Readonly<{
        sessionId: string;
        enabled: boolean;
      }>): Promise<unknown>;
    }>;
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      statusDemand: {
        machineId: 'machine-1',
        channel: {
          onExternalSessionStatusDemand: () => () => {},
          onConnectionStateChange: () => () => {},
        },
      },
      startPassiveObservation: (params) => {
        followLeaseManager = params.followLeaseManager;
        return {
          ready: Promise.resolve(),
          pause: async () => {},
          resume: async () => {},
          reconcileSession: async () => ({ status: 'settled' as const }),
          releaseSession: async () => {},
          dispose: async () => {},
        };
      },
    });
    const projectionParams = observationProjectionParams.current as null | Readonly<{
      shouldSendReadyNotification?: (sessionId: string) => boolean;
    }>;
    const shouldSendReadyNotification =
      projectionParams?.shouldSendReadyNotification;
    const manager = followLeaseManager as FollowLeaseManagerFixture;
    expect(shouldSendReadyNotification).toEqual(expect.any(Function));

    expect(shouldSendReadyNotification?.('session-1')).toBe(false);
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-1',
      enabled: true,
    });
    expect(shouldSendReadyNotification?.('session-1')).toBe(true);

    const attached = await manager.attach({
      sessionId: 'session-1',
      ttlMs: 30_000,
    });
    expect(shouldSendReadyNotification?.('session-1')).toBe(false);

    await manager.detach({
      sessionId: 'session-1',
      leaseId: attached.leaseId,
    });
    expect(shouldSendReadyNotification?.('session-1')).toBe(true);

    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-1',
      enabled: false,
    });
    expect(shouldSendReadyNotification?.('session-1')).toBe(false);
    await registration.dispose();
  });

  it('exposes passive External Sessions restoration to the daemon connectivity owner without starting during registration', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    const disposePassiveObservation = vi.fn(async () => {});
    const pausePassiveObservation = vi.fn(async () => {});
    const resumePassiveObservation = vi.fn(async () => {});
    const reconcilePassiveSession = vi.fn(async (_sessionId: string) => {});
    let onSessionArchivedStateChange:
      ((change: Readonly<{ sessionId: string; archived: boolean }>) => void | Promise<void>)
      | null = null;
    const detachSessionArchivedStateChanges = vi.fn();
    let capturedFollowLeaseManager:
      Parameters<typeof startExternalSessionPassiveObservation>[0]['followLeaseManager'];
    const startPassiveObservation = vi.fn((
      input: Parameters<typeof startExternalSessionPassiveObservation>[0],
    ) => {
      capturedFollowLeaseManager = input.followLeaseManager;
      return {
        ready: Promise.resolve(),
        pause: pausePassiveObservation,
        resume: resumePassiveObservation,
        reconcileSession: async (sessionId: string) => {
          reconcilePassiveSession(sessionId);
          await input.followLeaseManager?.resumeSession({
            sessionId,
            reason: 'session_archived',
          });
          return { status: 'settled' as const };
        },
        releaseSession: async (sessionId: string) => {
          await input.followLeaseManager?.archiveSession({
            sessionId,
          });
        },
        dispose: disposePassiveObservation,
      };
    });
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      statusDemand: {
        machineId: 'machine-1',
        channel: {
          onExternalSessionStatusDemand: () => () => {},
          onConnectionStateChange: () => () => {},
        },
      },
      startPassiveObservation,
      subscribeSessionArchivedStateChanges: (listener) => {
        onSessionArchivedStateChange = listener;
        return detachSessionArchivedStateChanges;
      },
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0]);

    expect(startPassiveObservation).toHaveBeenCalledWith({
      machineId: 'machine-1',
      projection: expect.objectContaining({
        reconcileLink: expect.any(Function),
      }),
      followLeaseManager: expect.any(Object),
      startPaused: true,
      reconcileSharedCredentialDemand: expect.any(Function),
    });
    expect(resumePassiveObservation).not.toHaveBeenCalled();

    await registration.connectivityResource?.resume();
    await registration.connectivityResource?.resume();
    expect(resumePassiveObservation).toHaveBeenCalledTimes(2);

    const manager = capturedFollowLeaseManager!;
    const emitSessionArchivedStateChange = onSessionArchivedStateChange as unknown as (
      change: Readonly<{ sessionId: string; archived: boolean }>,
    ) => void | Promise<void>;
    const release = vi.fn()
      .mockRejectedValueOnce(new Error('secret release failure'))
      .mockResolvedValueOnce(undefined);
    const acquireFollowLease = vi.fn(async () => ({ release }));
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-archived',
      enabled: true,
      acquireFollowLease,
    });

    await emitSessionArchivedStateChange({
      sessionId: 'session-archived',
      archived: true,
    });
    expect(manager.isSessionSuspended({
      sessionId: 'session-archived',
      reason: 'session_archived',
    })).toBe(true);
    expect(manager.hasBackgroundFollowLease('session-archived')).toBe(true);
    expect(writeFollowStatusMock).toHaveBeenLastCalledWith({
      sessionId: 'session-archived',
      followStatusV1: expect.objectContaining({
        status: 'error',
        reason: 'lease_release_failed',
      }),
      lastFollowIssueV1: expect.objectContaining({
        code: 'follow_lease_release_failed',
        retryable: true,
      }),
    });

    await emitSessionArchivedStateChange({
      sessionId: 'session-archived',
      archived: true,
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(manager.hasBackgroundFollowLease('session-archived')).toBe(false);
    expect(writeFollowStatusMock).toHaveBeenLastCalledWith({
      sessionId: 'session-archived',
      followStatusV1: expect.objectContaining({
        status: 'paused',
        reason: 'session_archived',
      }),
    });

    await emitSessionArchivedStateChange({
      sessionId: 'session-archived',
      archived: false,
    });
    expect(manager.isSessionSuspended({
      sessionId: 'session-archived',
      reason: 'session_archived',
    })).toBe(false);
    expect(acquireFollowLease).toHaveBeenCalledTimes(2);
    expect(manager.hasBackgroundFollowLease('session-archived')).toBe(true);
    expect(reconcilePassiveSession).toHaveBeenCalledExactlyOnceWith(
      'session-archived',
    );

    let finishRelease!: () => void;
    const pendingRelease = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    const acquireOrderedFollowLease = vi.fn(async () => ({
      release: async () => await pendingRelease,
    }));
    await manager.setBackgroundFollowEnabled({
      sessionId: 'session-archive-ordering',
      enabled: true,
      acquireFollowLease: acquireOrderedFollowLease,
    });

    const archiveTransition = Promise.resolve(emitSessionArchivedStateChange({
      sessionId: 'session-archive-ordering',
      archived: true,
    }));
    await vi.waitFor(() => {
      expect(manager.isSessionSuspended({
        sessionId: 'session-archive-ordering',
        reason: 'session_archived',
      })).toBe(true);
    });
    const unarchiveTransition = Promise.resolve(emitSessionArchivedStateChange({
      sessionId: 'session-archive-ordering',
      archived: false,
    }));
    finishRelease();
    await Promise.all([archiveTransition, unarchiveTransition]);

    expect(manager.isSessionSuspended({
      sessionId: 'session-archive-ordering',
      reason: 'session_archived',
    })).toBe(false);
    expect(acquireOrderedFollowLease).toHaveBeenCalledTimes(2);
    expect(manager.hasBackgroundFollowLease('session-archive-ordering')).toBe(true);

    await registration.dispose();
    expect(disposePassiveObservation).toHaveBeenCalledOnce();
    expect(detachSessionArchivedStateChanges).toHaveBeenCalledOnce();
  });

  it('registers required external-session action rows through the generic ActionSpec RPC registrar', async () => {
    const source = await readFile(new URL('./rpcHandlers.externalSessions.ts', import.meta.url), 'utf8');

    expect(source).toContain('registerActionSpecRpcHandlers({');
    expect(source).not.toContain('registerExternalSessionActionBackedRpcHandler');
  });

  it('requires the canonical admission owner and exposes no fallback persisted-takeover spawn seam', async () => {
    const source = await readFile(new URL('./rpcHandlers.externalSessions.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('preparePersistedTakeoverAdmissionSpawn');
    expect(source).toContain(
      'prepareSpawn: persistedTakeoverAdmissionOwner.prepareSpawn',
    );
  });

  it.each([
    RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
    RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START,
  ])('rejects import-advancing %s before the operation executor on a pre-fence server', async (method) => {
    const actionExecutor: RpcActionExecutor = {
      execute: vi.fn(async () => {
        throw new Error('operation executor must not run');
      }),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
    });

    const input = method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START
      ? {
          request: {
            v: 1,
            idempotencyKey: 'takeover-1',
            sessionId: 'linked-session-1',
            source: {
              machineId: 'machine-1',
              remoteSessionId: 'remote-session-1',
              qualifiedIdentity: {
                v: 1,
                agent: {
                  pluginId: 'acme.external',
                  localId: 'agent',
                },
                source: {
                  kind: 'source',
                  contractVersion: 1,
                },
              },
              linkGeneration: 'link-generation-1',
            },
            plan: 'takeover',
            targetStorageMode: 'persisted',
            targetDirectory: '/local/selected/workspace',
            targetRuntimeMode: 'terminal',
          },
        }
      : MATERIALIZE_START_TRANSPORT_INPUT;

    await expect(rpcHandlerManager.handlers.get(method)!(input)).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'upgrade_required',
      },
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it.each([
    RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL,
    RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD,
  ])('admits cleanup-only %s without advancing through the publication fence', async (method) => {
    const expected = {
      ok: false as const,
      error: {
        code: 'operation_not_found' as const,
        message: 'No operation exists.',
      },
    };
    const actionExecutor: RpcActionExecutor = {
      execute: vi.fn(async () => ({ ok: true as const, result: expected })),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
    });

    await expect(
      rpcHandlerManager.handlers.get(method)!(OPERATION_REFERENCE_TRANSPORT_INPUT),
    ).resolves.toEqual(expected);
    expect(actionExecutor.execute).toHaveBeenCalledOnce();
  });

  it('rejects the live persisted-takeover import before its executor on a pre-fence server', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: vi.fn(async () => {
        throw new Error('persisted takeover executor must not run');
      }),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
    });

    await expect(rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER)!({
      linkedSessionId: 'linked-session-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'persisted',
      machineId: 'machine-1',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'upgrade_required',
    });
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });

  it('admits import activation through the same executor when the server publishes the fence contract', async () => {
    const expected = {
      ok: false as const,
      error: {
        code: 'operation_not_found' as const,
        message: 'No operation exists.',
      },
    };
    const actionExecutor: RpcActionExecutor = {
      execute: vi.fn(async () => ({ ok: true as const, result: expected })),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(1),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
    });

    await expect(
      rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START)!(
        MATERIALIZE_START_TRANSPORT_INPUT,
      ),
    ).resolves.toEqual(expected);
    expect(actionExecutor.execute).toHaveBeenCalledOnce();
  });

  it.each([true, false])('routes candidates and typed unavailable results through the admitted registry (available: %s)', async (available) => {
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({
      controller: pluginReloadController,
      coldStart: true,
      plugins: [{
        manifest: createPluginManifestV2Fixture({
          id: 'acme.registry-candidates',
          contributes: { agents: [{
            id: 'history', title: 'Registry history',
            capabilities: { surfaces: ['externalSessions'] },
            surfaces: { externalSession: {
              sources: [{
                sourceKind: 'registryHistory',
                schema: { fields: [{ name: 'kind', kind: 'literal', value: 'registryHistory' }] },
                key: { segments: [{ kind: 'literal', value: 'registryHistory' }] },
                instances: [{ kind: 'default', constants: {} }],
              }],
            } },
          }] },
        }),
        files: { 'daemon.mjs': `
          export function activate(api) {
            api.agents.registerExternalSessions('history', {
              resolveSource: async ({ source }) => ({ ok: true, value: { source } }),
              listCandidates: async () => (${JSON.stringify(available
                ? { ok: true, value: { candidates: [], nextCursor: null } }
                : { ok: false, code: 'agent_unavailable', message: 'private fixture detail', retryable: true })}),
              resolveLinkIdentity: async ({ source, remoteSessionId }) => ({ ok: true, value: { source, remoteSessionId, linkData: {} } }),
              resolveLinkedIdentity: async ({ source, remoteSessionId, linkData }) => ({ ok: true, value: { source, remoteSessionId, linkData } }),
              pageTranscript: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
              readAfterTranscript: async () => ({ ok: true, value: { outcome: 'already_current' } }),
            });
          }
        ` },
      }],
    });
    fixtureCredentials.current = true;
    try {
      const agentId = runtime.registry.contributes.agents
        .find((agent) => agent.pluginId === 'acme.registry-candidates')?.id;
      expect(agentId).toBeDefined();
      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });
      const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
      const legacyHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY);
      expect(handler).toBeDefined();
      expect(legacyHandler).toBeDefined();
      const response = await handler!({
        machineId: 'machine-1',
        agentId,
        source: { kind: 'registryHistory' },
        limit: 10,
      });
      expect(response).toMatchObject(available ? {
        ok: true,
        candidates: [],
        nextCursor: null,
        autoLinkPolicyScopeV1: expect.any(Object),
      } : { ok: false, errorCode: 'agent_unavailable' });
      expect(JSON.stringify(response)).not.toContain('private fixture detail');
    } finally {
      await runtime.dispose();
    }
  });

  it.each([
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
      {
        machineId: 'machine-1',
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
        limit: 10,
      },
      ExternalSessionsCandidatesListResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE,
      {
        machineId: 'machine-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
      },
      ExternalSessionLinkEnsureResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        leaseId: 'lease-1',
      },
      ExternalSessionAttachResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        enabled: true,
      },
      ExternalSessionFollowPolicySetResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET,
      {
        machineId: 'machine-1',
        sessionId: 'session-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
      },
      ExternalSessionStatusGetResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_PAGE,
      {
        machineId: 'machine-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        direction: 'older',
      },
      ExternalSessionTranscriptPageResponseSchema,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TRANSCRIPT_READ_AFTER,
      {
        machineId: 'machine-1',
        agentId: 'codex',
        remoteSessionId: 'remote-session-1',
        source: { kind: 'codexHome', home: 'user' },
        cursor: 'cursor-1',
      },
      ExternalSessionTranscriptReadAfterResponseSchema,
    ],
  ] as const)(
    'returns a protocol-shaped %s precondition or missing-Agent outcome',
    async (method, input, responseSchema) => {
      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

      const handler = rpcHandlerManager.handlers.get(method);
      expect(handler).toBeDefined();

      const response = await handler!(input);

      const expectsAuthenticatedPersistedLink =
        method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH
        || method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET;
      const expectsPassiveUnknownStatus =
        method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_STATUS_GET;
      expect(response).toEqual(
        expectsAuthenticatedPersistedLink
          ? {
              ok: false,
              errorCode: 'agent_unavailable',
              error: 'not_authenticated',
            }
          : expectsPassiveUnknownStatus
            ? {
                ok: true,
                machineOnline: true,
                runnerActive: false,
                activity: 'unknown',
                canTakeOverDirect: false,
                canTakeOverPersist: false,
                canForceStop: false,
                trustedPid: null,
                externalAgent: null,
              }
            : {
                ok: false,
                errorCode: 'agent_unavailable',
                error: 'external_session_agent_unavailable',
              },
      );
      expect(responseSchema.safeParse(response).success).toBe(true);
    },
  );

  it('routes canonical and safe legacy RPCs while retiring both unphased legacy takeovers before domain execution', async () => {
    const calls: Array<Readonly<{ actionId: string; input: unknown }>> = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId, input) => {
        calls.push({ actionId, input });
        return {
          ok: true,
          result: { ok: true, candidates: [], nextCursor: null },
        };
      },
    };

    const rpcHandlerManager = createRpcHandlerManager();
    const params: Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    } = {
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(1),
    };
    registerMachineExternalSessionsRpcHandlers(params);

    const candidatesHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    const legacyCandidatesHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY);
    expect(candidatesHandler).toBeDefined();
    expect(legacyCandidatesHandler).toBeDefined();
    await expect(candidatesHandler!({
      machineId: 'machine-1',
      agentId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    })).resolves.toEqual({ ok: true, candidates: [], nextCursor: null });

    const takeoverHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY);
    const takeoverPersistHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY);
    expect(takeoverHandler).toBeDefined();
    expect(takeoverPersistHandler).toBeDefined();

    await expect(takeoverHandler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-1',
      forceStop: true,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'upgrade_required',
    });
    await expect(takeoverPersistHandler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-2',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'upgrade_required',
    });

    expect(calls).toEqual([
      {
        actionId: 'sessions.external.candidates.list',
        input: {
          machineId: 'machine-1',
          agentId: 'codex',
          source: { kind: 'codexHome', home: 'user' },
          limit: 10,
        },
      },
    ]);
  });

  it('keeps canonical agent-unavailable errors while translating legacy aliases to the released provider literal', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: async () => ({
        ok: true,
        result: {
          ok: false,
          errorCode: 'agent_unavailable',
          error: 'external_session_agent_unavailable',
        },
      }),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    });

    const canonicalHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST,
    );
    const legacyHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY,
    );
    const input = {
      machineId: 'machine-1',
      providerId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    };

    await expect(canonicalHandler!({ ...input, agentId: 'codex' })).resolves.toEqual({
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    });
    await expect(legacyHandler!(input)).resolves.toEqual({
      ok: false,
      errorCode: 'provider_unavailable',
      error: 'external_session_agent_unavailable',
    });
  });

  it('does not register never-released direct-session inbound follow methods', async () => {
    const calls: string[] = [];
    const actionExecutor: RpcActionExecutor = {
      execute: async (actionId) => {
        calls.push(actionId);
        return {
          ok: true,
          result: {
            ok: false,
            errorCode: 'agent_unavailable',
            error: 'external_session_agent_unavailable',
          },
        };
      },
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    });

    const canonicalHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET,
    );
    const canonicalAttachHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_ATTACH,
    );
    const canonicalDetachHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_DETACH,
    );
    const priorExternalHandler = rpcHandlerManager.handlers.get(
      'daemon.externalSessions.followPolicy.set',
    );
    const directAttachHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_DIRECT_SESSION_ATTACH_LEGACY,
    );
    const directDetachHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_DIRECT_SESSION_DETACH_LEGACY,
    );
    const directFollowPolicyHandler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY,
    );
    expect(canonicalHandler).toBeDefined();
    expect(canonicalAttachHandler).toBeDefined();
    expect(canonicalDetachHandler).toBeDefined();
    expect(priorExternalHandler).toBeUndefined();
    expect(directAttachHandler).toBeUndefined();
    expect(directDetachHandler).toBeUndefined();
    expect(directFollowPolicyHandler).toBeUndefined();

    const input = {
      machineId: 'machine-1',
      sessionId: 'linked-session-1',
      agentId: 'codex',
      remoteSessionId: 'remote-session-1',
      source: { kind: 'codexHome', home: 'user' },
      enabled: true,
    };
    const expected = {
      ok: false,
      errorCode: 'agent_unavailable',
      error: 'external_session_agent_unavailable',
    };
    await expect(canonicalHandler!(input)).resolves.toEqual(expected);
    expect(calls).toEqual(['sessions.external.backgroundFollow.set']);
  });

  it('maps generic external-session ActionExecuteResult failures to direct-session response envelopes', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: async () => ({
        ok: false,
        errorCode: 'unexpected_action_failure',
        error: 'unexpected_action_failure',
      }),
    };

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId: 'codex',
      source: { kind: 'codexHome', home: 'user' },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'internal_error',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
      MATERIALIZE_START_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_TAKEOVER_START,
      TAKEOVER_START_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_STATUS_GET,
      OPERATION_REFERENCE_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_CANCEL,
      OPERATION_REFERENCE_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RESUME,
      OPERATION_REFERENCE_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_RETRY,
      OPERATION_REFERENCE_TRANSPORT_INPUT,
    ],
    [
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_OPERATION_DISCARD,
      OPERATION_REFERENCE_TRANSPORT_INPUT,
    ],
  ] as const)(
    'maps a thrown durable Action failure at %s through the strict operation response binding',
    async (method, input) => {
      const actionExecutor: RpcActionExecutor = {
        execute: async () => {
          throw new Error('injected durable action failure');
        },
      };
      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager: rpcHandlerManager as never,
        actionExecutor,
        getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(3),
      } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
        actionExecutor: RpcActionExecutor;
        getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
      });

      const response = await rpcHandlerManager.handlers.get(method)!(input);
      expect(response).toMatchObject({
        ok: false,
        error: { code: 'internal_error' },
      });
      expect(
        ExternalSessionOperationActionResponseV1Schema.safeParse(response).success,
      ).toBe(true);
    },
  );

  it('maps an Action-domain durable failure through the same strict operation response binding', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: async () => ({
        ok: false,
        errorCode: 'external_session_action_failed',
        error: 'external_session_action_failed',
      }),
    };
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(3),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
      getServerFeaturesSnapshot: () => CliServerFeaturesSnapshot;
    });

    const response = await rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_EXTERNAL_SESSION_MATERIALIZE_START,
    )!(MATERIALIZE_START_TRANSPORT_INPUT);
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
    expect(
      ExternalSessionOperationActionResponseV1Schema.safeParse(response).success,
    ).toBe(true);
  });

  it(
    'retires legacy direct takeover before a throwing action executor can run',
    async () => {
      const actionExecutor: RpcActionExecutor = {
        execute: vi.fn(async () => {
          throw new Error('resolver exploded');
        }),
      };

      const rpcHandlerManager = createRpcHandlerManager();
      registerMachineExternalSessionsRpcHandlers({
        rpcHandlerManager: rpcHandlerManager as never,
        actionExecutor,
        getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(1),
      } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
        actionExecutor: RpcActionExecutor;
      });

      const handler = rpcHandlerManager.handlers.get(
        RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_LEGACY,
      );
      expect(handler).toBeDefined();

      await expect(handler!({
        machineId: 'machine-1',
        sessionId: '',
      })).resolves.toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'invalid_request',
      });

      const response = await handler!({
        machineId: 'machine-1',
        sessionId: 'linked-session-1',
      });

      expect(response).toEqual({
        ok: false,
        errorCode: 'invalid_request',
        error: 'upgrade_required',
      });
      expect(ExternalSessionTakeoverResponseSchema.safeParse(response).success).toBe(true);
      expect(actionExecutor.execute).not.toHaveBeenCalled();
    },
  );

  it('retires legacy persisted takeover before a throwing action executor can run', async () => {
    const actionExecutor: RpcActionExecutor = {
      execute: vi.fn(async () => {
        throw new Error('resolver exploded');
      }),
    };

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
      getServerFeaturesSnapshot: () => createServerFeaturesSnapshot(1),
    } as Parameters<typeof registerMachineExternalSessionsRpcHandlers>[0] & {
      actionExecutor: RpcActionExecutor;
    });

    const handler = rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST_LEGACY,
    );
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      sessionId: 'linked-session-1',
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'invalid_request',
      error: 'upgrade_required',
    });
    expect(ExternalSessionTakeoverPersistResponseSchema.safeParse(response).success).toBe(true);
    expect(actionExecutor.execute).not.toHaveBeenCalled();
  });
});
