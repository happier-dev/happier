import { readFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  ExternalSessionProviderFailureError,
  type ExternalSessionProviderOps,
} from '@/session/external/providerOps';
import type {
  AgentExternalSessionsContribution,
} from '@happier-dev/plugin-sdk/sessions/external';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import type { ExternalSessionHostOperationSet } from '@/session/external/hostOperationOwner';
import type {
  startExternalSessionPassiveObservation,
} from '@/api/session/external/leases/startExternalSessionPassiveObservation';

const {
  resolveExecutionSurfacesMock,
  observationProjectionParams,
  authoritativeRuntimeRegistryLeaseOverride,
  resolveTranscriptRefreshBindingMock,
  writeFollowStatusMock,
} = vi.hoisted(() => {
  const resolveExecutionSurfacesMock = vi.fn();
  return {
    resolveExecutionSurfacesMock,
    observationProjectionParams: {
      current: null as unknown,
    },
    authoritativeRuntimeRegistryLeaseOverride: {
      current: null as null | Readonly<{
        registry: unknown;
        release(): Promise<void>;
      }>,
    },
    resolveTranscriptRefreshBindingMock: vi.fn(),
    writeFollowStatusMock: vi.fn(async (_input: unknown) => {}),
  };
});

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: resolveExecutionSurfacesMock,
  }),
}));

vi.mock('@/plugins/runtime/reload/runtimeLease', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/plugins/runtime/reload/runtimeLease')
  >();
  return {
    ...actual,
    acquireAuthoritativePluginRuntimeRegistryLease: (
      ...args: Parameters<typeof actual.acquireAuthoritativePluginRuntimeRegistryLease>
    ) => authoritativeRuntimeRegistryLeaseOverride.current
      ?? actual.acquireAuthoritativePluginRuntimeRegistryLease(...args),
  };
});

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  const resolveFixtureCredentials = () => authoritativeRuntimeRegistryLeaseOverride.current
    ? Promise.resolve({
        token: 'fixture-token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array(),
        },
      })
    : null;
  return {
    ...actual,
    readCredentials: () => resolveFixtureCredentials() ?? actual.readCredentials(),
    readStoredCredentials: () => resolveFixtureCredentials() ?? actual.readStoredCredentials(),
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

vi.mock('@/api/session/external/secureRefresh/resolveExternalSessionTranscriptRefreshBinding', () => ({
  resolveExternalSessionTranscriptRefreshBinding: (...args: unknown[]) =>
    resolveTranscriptRefreshBindingMock(...args),
}));

// This host-composition test does not invoke bundled SCM behavior. Treat the
// concurrently edited plugin manifest as the package boundary it is, so its
// unrelated loading error cannot prevent this lifecycle contract from running.
vi.mock('@happier-dev/plugins-scm-azure-devops/manifest', () => ({
  PLUGIN_MANIFEST: {},
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
  beforeEach(() => {
    resolveExecutionSurfacesMock.mockReset();
    observationProjectionParams.current = null;
    authoritativeRuntimeRegistryLeaseOverride.current = null;
    resolveTranscriptRefreshBindingMock.mockReset();
    writeFollowStatusMock.mockReset();
    writeFollowStatusMock.mockResolvedValue(undefined);
  });

  it('injects daemon device-local custody into secure transcript read-after validation', async () => {
    resolveTranscriptRefreshBindingMock.mockResolvedValue(null);
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
      contributionGeneration: 'plugin-1',
      cursorIdentity: `external_session_cursor_binding_v1:${'a'.repeat(64)}`,
    };
    const cursor = 'happier_external_cursor_v1:Y3Vyc29yLTE';
    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      deviceLocalSecretStorage,
    });

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
    expect(resolveTranscriptRefreshBindingMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      cursor,
      deviceLocalSecretStorage,
    });
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

  it.each(['claude', 'codex', 'opencode', 'ohMyPi'] as const)(
    'resolves direct-session candidates through the held authoritative runtime registry for %s',
    async (agentId) => {
    const externalSessions = {
      resolveSource: vi.fn(async ({ source }) => ({ ok: true as const, value: { source } })),
      listCandidates: vi.fn(async () => ({
        ok: true as const,
        value: {
          candidates: [],
          nextCursor: null,
        },
      })),
      resolveLinkIdentity: vi.fn(async ({ source, remoteSessionId }) => ({
        ok: true as const,
        value: { source, remoteSessionId, linkData: {} },
      })),
      resolveLinkedIdentity: vi.fn(async ({ source, remoteSessionId, linkData }) => ({
        ok: true as const,
        value: { source, remoteSessionId, linkData },
      })),
      pageTranscript: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: [],
          nextCursor: null,
        },
      })),
      readAfterTranscript: vi.fn(async () => ({
        ok: true as const,
        value: { outcome: 'already_current' as const },
      })),
    } satisfies AgentExternalSessionsContribution;
    const pluginId = agentId === 'ohMyPi'
      ? 'happier.agent.ohmypi'
      : `fixture.${agentId}`;
    const localId = agentId === 'ohMyPi' ? 'ohmypi' : agentId;
    const source = agentId === 'ohMyPi'
      ? { kind: 'ohMyPiAgentDir' as const, agentDir: '/tmp/oh-my-pi-agent' }
      : { kind: 'codexHome' as const, home: 'user' as const };
    const sourceDeclaration = agentId === 'ohMyPi'
      ? {
          sourceKind: 'ohMyPiAgentDir',
          schema: {
            fields: [
              { name: 'kind', kind: 'literal', value: 'ohMyPiAgentDir' },
              {
                name: 'agentDir',
                kind: 'string',
                min: 1,
                max: 10_000,
                nullish: true,
              },
            ],
          },
          key: {
            segments: [
              { kind: 'literal', value: 'ohMyPiAgentDir' },
              { kind: 'field', field: 'agentDir' },
            ],
          },
          instances: [{ kind: 'default', constants: {} }],
        } as const
      : {
          sourceKind: 'codexHome',
          schema: {
            fields: [
              { name: 'kind', kind: 'literal', value: 'codexHome' },
              { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
            ],
          },
          key: {
            segments: [
              { kind: 'literal', value: 'codexHome' },
              { kind: 'homeMode', field: 'home' },
            ],
          },
          instances: [{ kind: 'default', constants: { home: 'user' } }],
        } as const;
    const agentContribution = {
      id: agentId,
      pluginId,
      identity: { pluginId, localId },
      richDefinition: {
        definition: {
          surfaces: {
            externalSession: {
              sources: [sourceDeclaration],
            },
          },
        },
      },
    };
    const retirement = new AbortController();
    const registry = {
      contributes: {
        agents: [agentContribution],
        agentDefinitionsById: new Map([[agentId, agentContribution]]),
      },
      agentRuntimesByAgentId: new Map([[agentId, {
        pluginId,
        pluginVersion: '1.0.0',
        agentId,
        generation: 'fixture-generation',
        hasPrimaryRuntime: false as const,
        externalSessions,
        retirementSignal: retirement.signal,
        isCurrent: () => true,
      }]]),
      activateContributionsOnDemand: vi.fn(async () => []),
    };
    const release = vi.fn(async () => {});
    authoritativeRuntimeRegistryLeaseOverride.current = {
      registry,
      release,
    };

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    const legacyHandler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST_LEGACY);
    expect(handler).toBeDefined();
    expect(legacyHandler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId,
      source,
      limit: 10,
    });
    // A caller-chosen Oh My Pi directory must be compared with the separately
    // resolved declaration-default directory. The other fixtures request the
    // declaration's exact authorized instance and reuse its first resolution.
    expect(externalSessions.resolveSource).toHaveBeenCalledTimes(
      agentId === 'ohMyPi' ? 2 : 1,
    );
    expect(externalSessions.listCandidates).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      ok: true,
      candidates: [],
      nextCursor: null,
      autoLinkPolicyScopeV1: expect.any(Object),
    });

    expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    },
  );

  it('returns a protocol-shaped candidates error when execution-surface resolution fails', async () => {
    resolveExecutionSurfacesMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
    );

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'external_sessions_candidates_list_failed',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns a typed provider-unavailable candidates error when the provider cannot list candidates', async () => {
    const externalSessions = {
      validateSource: vi.fn(async ({ source }) => ({ ok: true as const, source })),
      listCandidates: vi.fn(async () => {
        throw new ExternalSessionProviderFailureError({
          operation: 'externalSession.listCandidates',
          code: 'agent_unavailable',
          message: 'external_session_candidate_service_unavailable',
          retryable: true,
        });
      }),
      pageTranscript: vi.fn(async () => ({
        items: [],
        nextCursor: null,
        tailCursor: null,
        hasMore: false,
        truncated: false,
      })),
      readAfterTranscript: vi.fn(async () => ({ outcome: 'already_current' as const })),
    } satisfies ExternalSessionProviderOps;

    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: externalSessions,
      terminalRuntime: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'external_sessions_candidates_list_failed',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

  it('returns a protocol-shaped link.ensure error when execution-surface validation throws', async () => {
    resolveExecutionSurfacesMock.mockRejectedValueOnce(
      Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
    );

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSION_LINK_ENSURE);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId: 'codex',
      remoteSessionId: 'remote-session-1',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'external_session_link_ensure_failed',
    });
    expect(ExternalSessionLinkEnsureResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
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
      'external_session_attach_failed',
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
      'follow_policy_set_failed',
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
      'external_session_status_get_failed',
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
      'external_session_transcript_page_failed',
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
      'external_session_transcript_read_after_failed',
      ExternalSessionTranscriptReadAfterResponseSchema,
    ],
  ] as const)(
    'returns a protocol-shaped %s precondition or source-validation outcome',
    async (method, input, expectedError, responseSchema) => {
      resolveExecutionSurfacesMock.mockRejectedValueOnce(
        Object.assign(new Error('Cannot find providerOps chunk'), { code: 'ERR_MODULE_NOT_FOUND' }),
      );

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
                errorCode: 'internal_error',
                error: expectedError,
              },
      );
      if (expectsAuthenticatedPersistedLink || expectsPassiveUnknownStatus) {
        expect(resolveExecutionSurfacesMock).not.toHaveBeenCalled();
      }
      expect(responseSchema.safeParse(response).success).toBe(true);
    },
  );

  it('returns an internal candidates error when no authoritative Agent runtime registry is installed', async () => {
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: null,
      terminalRuntime: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });

    const rpcHandlerManager = createRpcHandlerManager();
    registerMachineExternalSessionsRpcHandlers({ rpcHandlerManager: rpcHandlerManager as never });

    const handler = rpcHandlerManager.handlers.get(RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST);
    expect(handler).toBeDefined();

    const response = await handler!({
      machineId: 'machine-1',
      agentId: 'codex',
      source: {
        kind: 'codexHome',
        home: 'user',
      },
      limit: 10,
    });

    expect(response).toEqual({
      ok: false,
      errorCode: 'internal_error',
      error: 'external_sessions_candidates_list_failed',
    });
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse(response).success).toBe(true);
  });

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
