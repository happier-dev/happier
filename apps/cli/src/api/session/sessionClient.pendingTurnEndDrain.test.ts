import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { createDeferred } from '@/testkit/async/deferred';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { encodeBase64, encrypt } from '../encryption';
import { accountSettingsParse } from '@happier-dev/protocol';
import {
  getActiveAccountSettingsSnapshot,
  setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { SessionMutationOutbox } from './mutations/createSessionMutationOutbox';
import { logger } from '@/ui/logger';
import {
  PendingQueueAcceptedSettlementError,
  PendingQueueMaterializationTransportAmbiguousError,
} from './pendingQueueV2Transport';
const providerInputOutcomeObservers = new WeakMap<object, (outcome: Readonly<{ kind: 'accepted'; localId: string }>) => void>();

function providerInputOutcomeObserver(client: any) {
  let observe = providerInputOutcomeObservers.get(client);
  if (!observe) {
    observe = client.bindProviderInputOutcomeProducer({
      providerId: 'codex',
      mode: 'unifiedTerminal',
      matchesCurrentSession: () => true,
    });
    providerInputOutcomeObservers.set(client, observe!);
  }
  return observe!;
}

function confirmProviderInputAccepted(
  client: any,
  localId: string,
): void {
  if (localId.trim().length === 0) return;
  providerInputOutcomeObserver(client)({ kind: 'accepted', localId });
}

function hasProviderInputAcceptance(client: any, localId: string): boolean {
  return client.hasPendingProviderInputAcceptance(localId) === true;
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const accountSettingsCredentialsSecret = new Uint8Array(32).fill(7);
const readCredentialsMock = vi.hoisted(() => vi.fn());
const cacheWritingSettingsRefreshMock = vi.hoisted(() => vi.fn());

vi.mock('@/persistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/persistence')>();
  return {
    ...actual,
    readCredentials: (...args: unknown[]) => readCredentialsMock(...args),
  };
});

vi.mock('@/settings/accountSettings/refreshAccountSettingsForMinimumVersion', () => ({
  refreshAccountSettingsForMinimumVersion: (...args: unknown[]) => cacheWritingSettingsRefreshMock(...args),
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

const enqueueSessionTurnMock = vi.fn(async (_mutation: unknown) => {});
const enqueueTranscriptMessageMock = vi.fn(async (_mutation: unknown) => ({ persisted: true, delivered: true }));
const flushOutboxMock = vi.fn(async (_reason: unknown) => {});
const closeOutboxMock = vi.fn(async () => {});
const setServerContractMock = vi.fn(async (_result: unknown) => {});

vi.mock('./mutations/createSessionMutationOutbox', () => ({
  createSessionMutationOutbox: (): SessionMutationOutbox => ({
    enqueueSessionTurn: (mutation: { action?: unknown }) => enqueueSessionTurnMock(mutation),
    enqueueTranscriptMessage: (mutation: unknown) => enqueueTranscriptMessageMock(mutation),
    enqueueRuntimeActivitySnapshot: async () => ({ persisted: true, delivered: true }),
    setSessionSyncPendingInputServerContract: (result: unknown) => setServerContractMock(result),
    readRuntimeActivitySnapshotTail: () => ({ sequence: 0, custody: null, settlement: null }),
    waitForRuntimeActivitySnapshotTailChange: async () => false,
    awaitReady: async () => {},
    flush: (reason: unknown) => flushOutboxMock(reason),
    close: () => closeOutboxMock(),
  }),
}));

let supervisorPhase = 'online';
let supervisorOnConnected: (() => Promise<void> | void) | null = null;
let supervisorConnectedPromise: Promise<void> | null = null;
const supervisorReportProbeResultMock = vi.fn();

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      supervisorOnConnected = params.onConnected ?? null;
      supervisorConnectedPromise = Promise.resolve(params.onConnected?.());
      await supervisorConnectedPromise;
    },
    stop: async () => {},
    getState: () => ({ phase: supervisorPhase }),
    reportProbeResult: supervisorReportProbeResultMock,
  }),
}));

const catchUpMock = vi.fn(async (_opts?: unknown) => {});

vi.mock('./sessionMessageCatchUp', () => ({
  catchUpSessionMessagesAfterSeq: (opts: unknown) => catchUpMock(opts),
}));

const fetchSnapshotMock = vi.fn();
const materializeNextMock = vi.fn();
const resolveAcceptedPendingDeliveryMock = vi.fn();
const blockPendingDeliveryMock = vi.fn();
const listProviderDeliveryLocalIdsMock = vi.fn();
const listDeliveryStatusesMock = vi.fn();
let sessionClientModulePromise: Promise<typeof import('./sessionClient')> | null = null;

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    materializeNextPendingQueueV2Message: (...args: unknown[]) => materializeNextMock(...args),
    resolveAcceptedPendingQueueV2Delivery: (...args: unknown[]) => resolveAcceptedPendingDeliveryMock(...args),
    blockPendingQueueV2Delivery: (...args: unknown[]) => blockPendingDeliveryMock(...args),
    listPendingQueueV2ProviderDeliveryLocalIdsFromServer: (...args: unknown[]) => listProviderDeliveryLocalIdsMock(...args),
    listPendingQueueV2DeliveryStatusesFromServer: (...args: unknown[]) => listDeliveryStatusesMock(...args),
  };
});

vi.mock('./snapshotSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snapshotSync')>();
  return {
    ...actual,
    fetchSessionSnapshotUpdateFromServer: (...args: unknown[]) => fetchSnapshotMock(...args),
  };
});

async function createClient(
  sessionOverrides: Record<string, unknown>,
  options: Readonly<{
    sessionSocketEmitWithAck?: NonNullable<Parameters<typeof createApiSessionSocketStub>[0]>['emitWithAck'];
    serverContractMode?: 'current' | 'released';
  }> = {},
) {
  const customEmitWithAck = options.sessionSocketEmitWithAck;
  sessionSocketStub = createApiSessionSocketStub({
    id: 'session-socket',
    connected: true,
    emitWithAck: (event, payload, socket) => {
      if (event === 'ping') {
        if (options.serverContractMode === 'released') return {};
        return { v: 1 };
      }
      return customEmitWithAck?.(event, payload, socket) ?? { ok: true };
    },
  });
  userSocketStub = createApiSessionSocketStub({ id: 'user-socket', connected: false });
  sessionClientModulePromise ??= import('./sessionClient');
  const { ApiSessionClient } = await sessionClientModulePromise;
  const fixture = createPlainSessionFixture({ id: 's1' });
  const client = new ApiSessionClient('tok', {
    ...fixture,
    ...sessionOverrides,
    metadata: {
      ...fixture.metadata,
      machineId: 'machine-1',
      ...(sessionOverrides.metadata && typeof sessionOverrides.metadata === 'object'
        ? sessionOverrides.metadata
        : {}),
    },
  } as any);
  (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
  await supervisorConnectedPromise;
  return client;
}

function triggerCommittedUserMessage(params: Readonly<{
  seq: number;
  localId: string;
  text?: string;
}>): void {
  if (!userSocketStub) throw new Error('Missing user socket stub');
  userSocketStub.trigger('update', {
    id: `update-${params.seq}`,
    createdAt: Date.now(),
    body: {
      t: 'new-message',
      sid: 's1',
      message: {
        id: `m${params.seq}`,
        seq: params.seq,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: params.text ?? `prompt ${params.seq}` },
            localId: params.localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        localId: params.localId,
        messageRole: 'user',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForCurrentPendingInputContract(client: Awaited<ReturnType<typeof createClient>>): Promise<void> {
  await waitUntil(() => (
    (client as any).sessionSyncPendingInputServerContract?.mode === 'session_sync_v2_pending_input_v1'
  ));
}

type MaterializeOptionsWithDeliveryTiming =
  NonNullable<Parameters<Awaited<ReturnType<typeof createClient>>['materializeNextPendingMessageSafely']>[0]> & {
    pendingQueueDeliveryTiming?: 'after_foreground_ready' | 'after_runtime_idle';
  };

function runtimeIdleMaterializeOptions(
  opts: MaterializeOptionsWithDeliveryTiming = {},
): MaterializeOptionsWithDeliveryTiming {
  return {
    reconcileWhenEmpty: 'force',
    pendingQueueDeliveryTiming: 'after_runtime_idle',
    ...opts,
  };
}

function createPendingDeliveryHttpError(
  status: number,
  error: string,
  opts: Readonly<{
    retryAfterMs?: number;
    correlationId?: string;
    retryAfterHeader?: string;
  }> = {},
): Error & {
  isAxiosError: true;
  response: {
    status: number;
    data: { error: string; retryAfterMs?: number; correlationId?: string };
    headers: Record<string, string>;
  };
} {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError: true;
    response: {
      status: number;
      data: { error: string; retryAfterMs?: number; correlationId?: string };
      headers: Record<string, string>;
    };
  };
  err.name = 'AxiosError';
  err.isAxiosError = true;
  err.response = {
    status,
    data: {
      error,
      ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
      ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    },
    headers: opts.retryAfterHeader ? { 'retry-after': opts.retryAfterHeader } : {},
  };
  return err;
}

function createProviderDeliveryMaterializeResult(localId: string, pendingVersion = 2) {
  return {
    didMaterialize: true,
    localId,
    didWrite: false,
    pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion },
    message: {
      id: null,
      seq: null,
      localId,
      messageRole: 'user',
      deliveryState: { mode: 'provider' as const, unresolved: true },
      content: {
        t: 'plain',
        v: {
          role: 'user',
          content: { type: 'text', text: `prompt ${localId}` },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
        },
      },
      createdAt: 1000,
      updatedAt: 1000,
    },
  };
}

describe('ApiSessionClient pending-queue turn-end drain', () => {
  beforeAll(async () => {
    sessionClientModulePromise ??= import('./sessionClient');
    await sessionClientModulePromise;
  }, 120_000);

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: {
        sharing: {
          pendingQueueV2: { enabled: true },
          pendingDeliveryState: { enabled: true },
        },
      },
      capabilities: {
        session: {
          runtimeActivity: { protocolVersion: 2 },
          pendingInput: { protocolVersion: 1 },
        },
      },
    }), { status: 200 })));
    supervisorOnConnected = null;
    supervisorConnectedPromise = null;
    supervisorReportProbeResultMock.mockReset();
    catchUpMock.mockReset();
    catchUpMock.mockResolvedValue(undefined);
    fetchSnapshotMock.mockReset();
    fetchSnapshotMock.mockResolvedValue({});
    materializeNextMock.mockReset();
    materializeNextMock.mockRejectedValue(new Error('not stubbed'));
    resolveAcceptedPendingDeliveryMock.mockReset();
    resolveAcceptedPendingDeliveryMock.mockResolvedValue({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    blockPendingDeliveryMock.mockReset();
    blockPendingDeliveryMock.mockResolvedValue({});
    listProviderDeliveryLocalIdsMock.mockReset();
    listProviderDeliveryLocalIdsMock.mockResolvedValue([]);
    listDeliveryStatusesMock.mockReset();
    listDeliveryStatusesMock.mockResolvedValue([]);
    enqueueSessionTurnMock.mockClear();
    enqueueTranscriptMessageMock.mockClear();
    flushOutboxMock.mockClear();
    closeOutboxMock.mockClear();
    setServerContractMock.mockClear();
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue({
      token: 'tok',
      encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
    });
    cacheWritingSettingsRefreshMock.mockReset();
    cacheWritingSettingsRefreshMock.mockResolvedValue({
      source: 'network',
      settings: accountSettingsParse({}),
      settingsVersion: 0,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
      whenRefreshed: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('blocks a contract-invalid provider action before invoking provider input', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'invalid-provider-action-local',
      didWrite: false,
      message: null,
      providerDeliveryContractInvalid: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });

    expect(delivered).toEqual([]);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'invalid-provider-action-local',
      reason: 'unsupported_action',
    });
  });

  it('uses one exact current contract result object for Runtime and Pending consumers', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const contract = (client as any).sessionSyncPendingInputServerContract;
    expect(contract).toEqual({
      mode: 'session_sync_v2_pending_input_v1',
      runtimeActivity: 'v2',
      pendingInput: 'v1',
      sessionConnectionEpoch: 1,
      socket: sessionSocketStub,
    });
    expect(setServerContractMock).toHaveBeenCalledWith(contract);
    expect(setServerContractMock.mock.calls[0]?.[0]).toBe(contract);
    materializeNextMock.mockResolvedValueOnce({ didMaterialize: false, localId: null, didWrite: false });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('performs zero provider input when the current result object is replaced during materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));
    materializeNextMock.mockImplementationOnce(async () => {
      const current = (client as any).sessionSyncPendingInputServerContract;
      (client as any).sessionSyncPendingInputServerContract = { ...current };
      return {
        didMaterialize: true,
        localId: 'stale-current-local',
        didWrite: true,
        message: {
          id: 'stale-current-message',
          seq: 9,
          localId: 'stale-current-local',
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'do not deliver' } } },
          createdAt: 100,
          updatedAt: 101,
        },
      };
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'retryable_transport' });
    expect(delivered).toEqual([]);
  });

  it('does not report stale authentication after the current result object is replaced', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    materializeNextMock.mockImplementationOnce(async () => {
      const current = (client as any).sessionSyncPendingInputServerContract;
      (client as any).sessionSyncPendingInputServerContract = { ...current };
      throw createPendingDeliveryHttpError(401, 'unauthorized');
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual({ type: 'retryable_transport' });
  });

  it('selects only the released adapter from the identical old-server contract result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: { sharing: { pendingQueueV2: { enabled: true } } },
      capabilities: {},
    }), { status: 200 })));
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (!String(url).includes('/messages/by-local-id/released-local-1')) {
        throw new Error(`Unexpected HTTP GET in released adapter test: ${String(url)}`);
      }
      return {
        status: 200,
        data: {
          message: {
            id: 'released-message-1',
            seq: 8,
            localId: 'released-local-1',
            sidechainId: null,
            createdAt: 100,
            updatedAt: 101,
            content: {
              t: 'plain',
              v: { role: 'user', content: { type: 'text', text: 'released prompt' } },
            },
          },
        },
      };
    });
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    }, {
      serverContractMode: 'released',
      sessionSocketEmitWithAck: (event) => event === 'pending-materialize-next'
        ? {
          ok: true,
          didMaterialize: true,
          didWrite: true,
          message: { id: 'released-message-1', seq: 8, localId: 'released-local-1' },
        }
        : { ok: false },
    });
    await waitUntil(() => (client as any).sessionSyncPendingInputServerContract !== null);
    const contract = (client as any).sessionSyncPendingInputServerContract;
    expect(contract.mode).toBe('released_server_v0_2_1');
    expect(setServerContractMock.mock.calls[0]?.[0]).toBe(contract);
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({
        type: 'materialized',
        localId: 'released-local-1',
        seq: 8,
      });
    expect(materializeNextMock).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(1);
  });

  it.each([
    ['indeterminate', new Response(JSON.stringify({ invalid: true }), { status: 200 }), { type: 'retryable_transport' }],
    ['auth_failed', new Response('', { status: 401 }), { type: 'auth_failure', statusCode: 401 }],
  ] as const)('performs zero provider input for %s contract evidence', async (_name, featureResponse, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(featureResponse));
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toEqual(expected);
    expect(materializeNextMock).not.toHaveBeenCalled();
  });

  it('does not attempt materialization when every queued pending row is blocked', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 1,
      pendingVersion: 1,
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'skip',
    })).resolves.toEqual({ type: 'no_pending' });
    expect(materializeNextMock).not.toHaveBeenCalled();
  });


  it('reports an active foreground turn as steerable when the caller owns in-flight steer', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'live-steer-local',
      didWrite: true,
      message: {
        id: 'm-live-steer',
        seq: 42,
        localId: 'live-steer-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      activeTurnSteerability: 'steerable',
    });

    expect(materializeNextMock).toHaveBeenCalled();
    expect(result).toEqual({
      type: 'materialized',
      localId: 'live-steer-local',
      seq: 42,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'steer now' } } },
      createdAt: 1000,
      updatedAt: 1000,
    });
  });

  it('keeps default foreground-ready queued materialization eligible while runtime activity is active', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: Date.now(),
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'foreground-ready-local',
      didWrite: true,
      message: {
        id: 'm-foreground-ready',
        seq: 43,
        localId: 'foreground-ready-local',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'queued prompt' } } },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
      pendingQueueDeliveryTiming: 'after_foreground_ready',
    } satisfies MaterializeOptionsWithDeliveryTiming)).resolves.toMatchObject({
      type: 'materialized',
      localId: 'foreground-ready-local',
    });
    expect(materializeNextMock).toHaveBeenCalled();
  });

  it('wakes runtime-idle delivery from the durable explicit idle revision exactly once', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
      runtimeActivityObservedAt: 9_000,
      runtimeActivityRevision: 4,
    });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      deferredReason: 'waiting_for_runtime_activity',
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'deferred',
      reason: 'waiting_for_runtime_activity',
    });

    const wake = client.waitForMetadataUpdate();
    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'runtime-activity-snapshot-idle',
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        sid: 's1',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 10_000,
        runtimeActivityRevision: 5,
      },
    });

    await expect(wake).resolves.toBe(true);
    expect(client.shouldAttemptPendingMaterialization(runtimeIdleMaterializeOptions())).toBe(true);

    const duplicateWaitAbort = new AbortController();
    let duplicateWake: boolean | null = null;
    const duplicateWait = client.waitForMetadataUpdate(duplicateWaitAbort.signal).then((result) => {
      duplicateWake = result;
    });
    userSocketStub.trigger('update', {
      id: 'runtime-activity-snapshot-idle-duplicate',
      createdAt: Date.now(),
      body: {
        t: 'update-session',
        sid: 's1',
        runtimeActivityState: 'idle',
        runtimeActivityActiveCount: 0,
        runtimeActivityObservedAt: 10_000,
        runtimeActivityRevision: 5,
      },
    });
    await Promise.resolve();
    expect(duplicateWake).toBeNull();
    duplicateWaitAbort.abort();
    await duplicateWait;
    expect(duplicateWake).toBe(false);
  });

  it('wakes after a locally applied timing change broadens ordinary eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    const snapshot = (timing: 'after_runtime_idle' | 'after_foreground_ready', version: number) => ({
      source: 'network' as const,
      settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: timing }),
      settingsVersion: version,
      loadedAtMs: version,
      settingsSecretsReadKeys: [],
    });
    setActiveAccountSettingsSnapshot(snapshot('after_runtime_idle', 20));
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
    });
    const wake = client.waitForMetadataUpdate();

    setActiveAccountSettingsSnapshot(snapshot('after_foreground_ready', 21));

    await expect(wake).resolves.toBe(true);

    const reverseAbort = new AbortController();
    const reverseWake = client.waitForMetadataUpdate(reverseAbort.signal);
    setActiveAccountSettingsSnapshot(snapshot('after_runtime_idle', 22));
    await Promise.resolve();
    reverseAbort.abort();
    await expect(reverseWake).resolves.toBe(false);
    if (previous) setActiveAccountSettingsSnapshot(previous);
  });

  it('applies a user-scoped account settings update before publishing a following pending wake', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();

      userSocketStub.trigger('update', {
        id: 'account-settings-v1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: {
              t: 'encrypted',
              c: encodeBase64(encrypt(accountSettingsCredentialsSecret, 'legacy', {
                sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
              })),
            },
            version: 1,
          },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-settings-v1',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 1,
        settings: expect.objectContaining({
          sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
        }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('uses a strict request-only settings refresh for reconnect convergence without the cache-writing bootstrap owner', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      } as never);

      await (client as unknown as {
        refreshAccountSettingsFromChangesHint: (version: number | null) => Promise<void>;
      }).refreshAccountSettingsFromChangesHint(5);

      expect(cacheWritingSettingsRefreshMock).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/account\/settings$/),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 5 });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('converges settings on the real user-socket connect before resolving Pending eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      const response = createDeferred<{
        status: number;
        data: {
          content: { t: 'plain'; v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } };
          version: number;
        };
      }>();
      const get = vi.spyOn(axios, 'get').mockImplementationOnce(() => response.promise as never);
      let wakeResult: boolean | null = null;

      const wake = client.waitForPendingEligibilityUpdate();
      void wake.then((value) => {
        wakeResult = value;
      });
      await waitUntil(() => get.mock.calls.length === 1);

      expect(get).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/account\/settings$/),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }),
      );
      expect(wakeResult).toBeNull();

      response.resolve({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      });
      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('shares one settings convergence when the user and session sockets reconnect together', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      if (!userSocketStub || !sessionSocketStub || !supervisorOnConnected) {
        throw new Error('missing reconnect harness');
      }

      const settingsResponse = createDeferred<{
        status: number;
        data: {
          content: { t: 'plain'; v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } };
          version: number;
        };
      }>();
      const get = vi.spyOn(axios, 'get').mockImplementation((url) => {
        const path = String(url);
        if (path.endsWith('/v2/changes')) {
          return Promise.resolve({
            status: 200,
            data: { changes: [], nextCursor: 1 },
          }) as never;
        }
        if (path.endsWith('/v2/account/settings')) {
          return settingsResponse.promise as never;
        }
        throw new Error(`Unexpected reconnect GET: ${path}`);
      });

      userSocketStub.connected = false;
      userSocketStub.connect.mockImplementation(() => userSocketStub as never);
      const wake = client.waitForPendingEligibilityUpdate();
      let wakeResult: boolean | null = null;
      void wake.then((value) => {
        wakeResult = value;
      });

      const reconnect = Promise.resolve(supervisorOnConnected());
      await waitUntil(() => get.mock.calls.some(([url]) => String(url).endsWith('/v2/account/settings')));
      userSocketStub.connected = true;
      userSocketStub.trigger('connect');
      await Promise.resolve();

      expect(wakeResult).toBeNull();
      settingsResponse.resolve({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 5,
        },
      });

      await reconnect;
      await expect(wake).resolves.toBe(true);
      expect(get.mock.calls.filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(1);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
      expect((client as unknown as {
        userSocketSettingsConnectionEpoch: number;
        userSocketSettingsConvergedEpoch: number;
      }).userSocketSettingsConvergedEpoch).toBe(
        (client as unknown as { userSocketSettingsConnectionEpoch: number }).userSocketSettingsConnectionEpoch,
      );
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it.each([
    {
      name: 'credential token differs from the session token',
      prepare: () => readCredentialsMock.mockResolvedValueOnce({
        token: 'different-token',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      }),
      accountId: 'account-1',
    },
    {
      name: 'payload account differs from the authenticated account',
      prepare: () => {},
      accountId: 'different-account',
    },
  ])('fails closed when live settings binding is invalid: $name', async ({ prepare, accountId }) => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      prepare();

      userSocketStub.trigger('update', {
        id: `binding-${accountId}`,
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: accountId,
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('invalidates an older in-flight live apply when a malformed successor arrives', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const credentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => credentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-valid-v1',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.trigger('update', {
        id: 'settings-malformed-v2',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 2 },
        },
      });
      credentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await Promise.resolve();
      await waitUntil(() => readCredentialsMock.mock.results[0]?.type === 'return');
      await new Promise((resolve) => setImmediate(resolve));
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('does not let an older live settings version invalidate a newer in-flight apply', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const newerCredentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => newerCredentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-newer-v5',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 5,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.trigger('update', {
        id: 'settings-older-v4',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
            version: 4,
          },
        },
      });
      newerCredentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await waitUntil(() => getActiveAccountSettingsSnapshot()?.settingsVersion === 5);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({
        settingsVersion: 5,
        settings: expect.objectContaining({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
      });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('requires the real user socket to remain connected before a live settings commit', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      (client as unknown as { accountIdPromise: Promise<string> }).accountIdPromise = Promise.resolve('account-1');
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const credentials = createDeferred<{
        token: string;
        encryption: { type: 'legacy'; secret: Uint8Array };
      }>();
      readCredentialsMock.mockImplementationOnce(() => credentials.promise);

      userSocketStub.trigger('update', {
        id: 'settings-before-disconnect',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 1,
          },
        },
      });
      await waitUntil(() => readCredentialsMock.mock.calls.length > 0);
      userSocketStub.disconnect();
      credentials.resolve({
        token: 'tok',
        encryption: { type: 'legacy', secret: accountSettingsCredentialsSecret },
      });

      await new Promise((resolve) => setImmediate(resolve));
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('publishes one broaden wake when queued live settings updates finish with broader eligibility', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_runtime_idle' }),
        settingsVersion: 20,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      if (!userSocketStub) throw new Error('missing user socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();
      const foregroundSettingsContent = {
        t: 'encrypted' as const,
        c: encodeBase64(encrypt(accountSettingsCredentialsSecret, 'legacy', {
          sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
        })),
      };

      userSocketStub.trigger('update', {
        id: 'account-settings-v21',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: foregroundSettingsContent, version: 21 },
        },
      });
      userSocketStub.trigger('update', {
        id: 'account-settings-v22',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: foregroundSettingsContent, version: 22 },
        },
      });

      await expect(Promise.race([
        wake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(22);

      const duplicateWaitAbort = new AbortController();
      const duplicateWait = client.waitForMetadataUpdate(duplicateWaitAbort.signal);
      let duplicateWake: boolean | null = null;
      void duplicateWait.then((value) => {
        duplicateWake = value;
      });
      await Promise.resolve();
      expect(duplicateWake).toBeNull();
      duplicateWaitAbort.abort();
      await expect(duplicateWait).resolves.toBe(false);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('does not publish a Pending eligibility wake when live settings narrow ordinary delivery', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 1,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      if (!userSocketStub) throw new Error('missing user socket stub');

      const abort = new AbortController();
      const wake = client.waitForPendingEligibilityUpdate(abort.signal);
      userSocketStub.trigger('update', {
        id: 'account-settings-narrow-v2',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: {
            content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
            version: 2,
          },
        },
      });
      await waitUntil(() => getActiveAccountSettingsSnapshot()?.settingsVersion === 2);
      abort.abort();

      await expect(wake).resolves.toBe(false);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('releases a fail-closed Pending hint after malformed settings and retries convergence on the same socket', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({ latestTurnStatus: 'completed', pendingCount: 0, pendingVersion: 0 });
      const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' } },
          version: 1,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');

      const failedWake = client.waitForPendingEligibilityUpdate();
      userSocketStub.trigger('update', {
        id: 'account-settings-malformed-v2-recovery',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 2 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-malformed-settings',
        seq: 3,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });
      await expect(Promise.race([
        failedWake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);

      get.mockResolvedValueOnce({
        status: 200,
        data: {
          content: { t: 'plain', v: { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' } },
          version: 3,
        },
      } as never);
      await expect(client.waitForPendingEligibilityUpdate()).resolves.toBe(true);
      expect(get).toHaveBeenCalledTimes(2);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(3);
      expect((client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier).toBeNull();
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it.each([
    {
      name: 'malformed payload',
      prepare: () => {},
      settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
    },
    {
      name: 'missing credentials',
      prepare: () => readCredentialsMock.mockResolvedValueOnce(null),
      settingsV2: { content: { t: 'plain', v: {} }, version: 1 },
    },
  ])('preserves verdict-free wakes and unrelated updates after a failed live settings update: $name', async ({ prepare, settingsV2 }) => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const wake = client.waitForMetadataUpdate();
      const unrelatedUpdates: unknown[] = [];
      client.on('message', (message) => unrelatedUpdates.push(message));
      prepare();

      userSocketStub.trigger('update', {
        id: 'account-settings-failed',
        seq: 1,
        createdAt: Date.now(),
        body: { t: 'update-account', id: 'account-1', settingsV2 },
      });
      userSocketStub.trigger('update', {
        id: 'unrelated-automation-update',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'automation-upsert',
          automationId: 'automation-1',
          version: 1,
          enabled: true,
          updatedAt: Date.now(),
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'pending-after-failed-settings',
        seq: 3,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      await waitUntil(() => unrelatedUpdates.length === 1);
      expect(unrelatedUpdates).toHaveLength(1);
      await expect(wake).resolves.toBe(true);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('preserves unrelated update-session state when a live settings update cannot be applied', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: 10,
        runtimeActivityRevision: 1,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const metadataWake = client.waitForMetadataUpdate();
      const pendingWakeSeqBefore = (client as unknown as { pendingWakeSeq: number }).pendingWakeSeq;
      materializeNextMock.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({ deliveryTiming: 'after_runtime_idle' });
        expect(params.expectedRuntimeActivityRevision).toBeUndefined();
        return {
          didMaterialize: false,
          deferredReason: 'waiting_for_runtime_activity',
          pendingQueueState: {
            known: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
          },
        };
      });

      userSocketStub.trigger('update', {
        id: 'account-settings-decrypt-failed',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'mixed-session-state-after-failed-settings',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'update-session',
          sid: 's1',
          metadata: {
            version: 10,
            value: JSON.stringify({ path: '/synthetic/live-settings-state-preserved' }),
          },
          runtimeActivityState: 'idle',
          runtimeActivityActiveCount: 0,
          runtimeActivityObservedAt: 20,
          runtimeActivityRevision: 2,
        },
      });

      await waitUntil(() => (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> | null })
        .accountSettingsSyncBarrier !== null);
      await (client as unknown as { accountSettingsSyncBarrier: Promise<boolean> }).accountSettingsSyncBarrier;
      await Promise.resolve();

      expect((client as unknown as { metadata: { path?: string } | null }).metadata?.path)
        .toBe('/synthetic/live-settings-state-preserved');
      await expect(metadataWake).resolves.toBe(true);
      expect((client as unknown as { runtimeActivityProjection: { runtimeActivityState?: string } })
        .runtimeActivityProjection.runtimeActivityState).toBe('idle');
      expect((client as unknown as { pendingWakeSeq: number }).pendingWakeSeq).toBe(pendingWakeSeqBefore + 1);
      expect(getActiveAccountSettingsSnapshot()?.settingsVersion).toBe(0);
      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
        .resolves.toEqual({ type: 'deferred', reason: 'waiting_for_runtime_activity' });
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('keeps an explicit steer eligible after a live settings update cannot be applied', async () => {
    const previous = getActiveAccountSettingsSnapshot();
    try {
      setActiveAccountSettingsSnapshot({
        source: 'network',
        settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: 'after_foreground_ready' }),
        settingsVersion: 0,
        loadedAtMs: 1,
        settingsSecretsReadKeys: [],
      });
      const client = await createClient({
        latestTurnStatus: 'in_progress',
        pendingCount: 0,
        pendingVersion: 0,
      });
      if (!userSocketStub || !sessionSocketStub) throw new Error('missing socket stub');
      userSocketStub.connect();
      const pendingWake = client.waitForMetadataUpdate();
      const delivered: Array<{ info?: { pendingProviderAction?: string } }> = [];
      client.onUserMessage((_message, info) => delivered.push({ info }));

      userSocketStub.trigger('update', {
        id: 'account-settings-decrypt-failed-before-steer',
        seq: 1,
        createdAt: Date.now(),
        body: {
          t: 'update-account',
          id: 'account-1',
          settingsV2: { content: { t: 'encrypted', c: '' }, version: 1 },
        },
      });
      sessionSocketStub.trigger('update', {
        id: 'explicit-steer-after-failed-settings',
        seq: 2,
        createdAt: Date.now(),
        body: {
          t: 'pending-changed',
          sid: 's1',
          pendingVersion: 1,
          pendingCount: 1,
        },
      });

      await expect(Promise.race([
        pendingWake,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
      ])).resolves.toBe(true);
      materializeNextMock.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({
          deliveryTiming: 'after_runtime_idle',
          foregroundState: 'active_steerable',
        });
        const result = createProviderDeliveryMaterializeResult('explicit-steer-local', 2);
        return {
          ...result,
          pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
          message: { ...result.message, providerAction: 'steer' as const },
        };
      });

      await expect(client.materializeNextPendingMessageSafely({
        reconcileWhenEmpty: 'force',
        activeTurnSteerability: 'steerable',
      })).resolves.toMatchObject({ type: 'materialized', localId: 'explicit-steer-local' });
      expect(delivered).toEqual([{ info: expect.objectContaining({ pendingProviderAction: 'steer' }) }]);
    } finally {
      if (previous) setActiveAccountSettingsSnapshot(previous);
    }
  });

  it('preserves unresolved-head backpressure instead of reporting no pending work', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      deferredReason: 'waiting_for_predecessor',
      pendingQueueState: {
        known: true,
        pendingCount: 2,
        pendingBlockedCount: 0,
        pendingVersion: 7,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
    })).resolves.toEqual({
      type: 'deferred',
      reason: 'waiting_for_predecessor',
    });
  });

  it('returns typed retryable transport without arming a client retry timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude', observedAt: Date.now() });
    const transportFailure = new PendingQueueMaterializationTransportAmbiguousError(
      new Error('materialize acknowledgement timed out'),
    );
    materializeNextMock
      .mockRejectedValueOnce(transportFailure)
      .mockResolvedValueOnce({
        didMaterialize: true,
        didWrite: true,
        localId: 'local-retry',
        message: {
          seq: 10,
          localId: 'local-retry',
          messageRole: 'user',
          content: { role: 'user', content: { type: 'text', text: 'retry wake' } },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        pendingQueueState: {
          known: true,
          pendingCount: 0,
          pendingBlockedCount: 0,
          pendingVersion: 2,
        },
      });

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'pending-changed-retry',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingVersion: 1,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({
      activeTurnSteerability: 'steerable',
    })).resolves.toEqual({ type: 'retryable_transport', retryAfterMs: 250 });
    expect(infoFileSpy).toHaveBeenCalledWith(
      '[pendingQueue] materialize request failed',
      expect.objectContaining({
        sessionId: 's1',
        error: expect.objectContaining({
          code: 'pending_queue_materialization_transport_ambiguous',
          diagnosticCode: 'pending_queue_materialization_transport_failure',
          classification: 'transport_failure',
          cause: expect.objectContaining({ message: 'materialize acknowledgement timed out' }),
        }),
      }),
    );
    expect(infoFileSpy).toHaveBeenCalledTimes(1);
    expect((client as unknown as { pendingMaterializeRetryWakeTimer?: unknown }).pendingMaterializeRetryWakeTimer)
      .toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);

    await expect(client.materializeNextPendingMessageSafely({
      activeTurnSteerability: 'steerable',
    })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'local-retry',
      seq: 10,
    });
    expect(client.sessionTurnLifecycle.hasActiveTurn()).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('passes runtime-idle delivery timing to server materialization when locally eligible', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      runtimeActivityActiveCount: 0,
      runtimeActivityObservedAt: null,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    await expect(client.materializeNextPendingMessageSafely(runtimeIdleMaterializeOptions())).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryTiming: 'after_runtime_idle',
    }));
  });

  it('ignores inert continuation recovery metadata when deciding pending materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: {
        sessionContinuationRecoveryV1: {
          v: 1,
          attemptsById: {
            'generation-1:restart-1': {
              v: 1,
              attemptId: 'generation-1:restart-1',
              status: 'pending_provider_context',
              failureAtMs: 100,
              updatedAtMs: 110,
              resumePromptMode: 'standard',
            },
          },
        },
      },
    });

    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('canonical turn cancellation also unblocks materialization', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.cancelTurn({ provider: 'claude' });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
  });

  it('drains the next row after a newer local turn end despite an older in-progress snapshot', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_000,
      pendingCount: 1,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    client.onUserMessage(() => {});
    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    fetchSnapshotMock.mockResolvedValue({
      latestTurnStatus: 'in_progress',
      latestTurnStatusObservedAt: 1_500,
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await client.reconcilePendingQueueState({ force: true });

    const materialized = createProviderDeliveryMaterializeResult('turn-end-neighbor');
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        providerAction: 'send' as const,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized', localId: 'turn-end-neighbor' });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      foregroundState: 'ready',
    }));
    nowSpy.mockRestore();
  });

  it.each([
    {
      label: 'an in-progress snapshot without an observation timestamp',
      initialObservedAt: 2_000,
      snapshotObservedAt: undefined,
      expectedForegroundState: 'ready',
    },
    {
      label: 'a genuinely newer in-progress snapshot',
      initialObservedAt: 1_000,
      snapshotObservedAt: 2_000,
      expectedForegroundState: 'active_unsteerable',
    },
  ] as const)('treats $label monotonically', async ({
    initialObservedAt,
    snapshotObservedAt,
    expectedForegroundState,
  }) => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      latestTurnStatusObservedAt: initialObservedAt,
      pendingCount: 1,
      pendingVersion: 1,
    });
    await waitForCurrentPendingInputContract(client);
    client.onUserMessage(() => {});
    fetchSnapshotMock.mockResolvedValue({
      latestTurnStatus: 'in_progress',
      ...(snapshotObservedAt !== undefined
        ? { latestTurnStatusObservedAt: snapshotObservedAt }
        : {}),
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 1,
      },
    });
    await client.reconcilePendingQueueState({ force: true });

    const materialized = createProviderDeliveryMaterializeResult(`monotonic-${expectedForegroundState}`);
    materializeNextMock.mockResolvedValueOnce({
      ...materialized,
      message: {
        ...materialized.message,
        providerAction: 'send' as const,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' }))
      .resolves.toMatchObject({ type: 'materialized' });
    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      foregroundState: expectedForegroundState,
    }));
  });

  it('wakes pending consumers on turn completion (metadata-updated)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 1,
      pendingVersion: 1,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });

    let woke = 0;
    client.on('metadata-updated', () => {
      woke += 1;
    });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    expect(woke).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a stale-empty pending count on turn completion (lost-nudge recovery)', async () => {
    const client = await createClient({
      latestTurnStatus: 'in_progress',
      pendingCount: 0,
      pendingVersion: 0,
    });

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    fetchSnapshotMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchSnapshotMock).toHaveBeenCalled();
  });

  it('reports pending queue reconciliation changes when only the blocked count changes', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 7,
    });
    fetchSnapshotMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 2,
        pendingBlockedCount: 1,
        pendingVersion: 7,
      },
    });

    await expect(client.reconcilePendingQueueState({ force: true })).resolves.toBe(true);
  });

  it('does not infer provider acceptance and re-enters the canonical claim owner', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 42 },
    });
    listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['delivering-local']);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: false,
      localId: null,
      didWrite: false,
      deferredReason: 'waiting_for_predecessor',
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 },
    });

    const result = await client.materializeNextPendingMessageSafely({
      reconcileWhenEmpty: 'force',
    });

    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ type: 'deferred', reason: 'waiting_for_predecessor' });
  });

  it('always requests the current canonical provider-delivery state', async () => {
    const client = await createClient({
      pendingCount: 1,
      pendingVersion: 1,
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: false,
      localId: null,
      didWrite: false,
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });

    expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStateOptIn: true,
    }));
  });
  it('ignores provider acceptance that is not tied to a canonical materialized claim', async () => {
    const client = await createClient({
      pendingCount: 0,
      pendingVersion: 0,
    });

    confirmProviderInputAccepted(client, 'prompt-late-seq');

    expect(hasProviderInputAcceptance(client, 'prompt-late-seq')).toBe(false);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();

    triggerCommittedUserMessage({ seq: 740, localId: 'prompt-late-seq' });

    expect(hasProviderInputAcceptance(client, 'prompt-late-seq')).toBe(false);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('resolves server-owned provider delivery after provider acceptance', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'new-server-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-new-server',
        seq: 43,
        localId: 'new-server-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'new server prompt' },
            localId: 'new-server-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const result = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect((result as any).deliveryState).toEqual(deliveryState);

    confirmProviderInputAccepted(client, 'new-server-local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'new-server-local',
    });
    expect(hasProviderInputAcceptance(client, 'new-server-local')).toBe(true);
  });

  it('retries only the exact accepted settlement at typed 503 delay without changing socket health', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError(
        'transaction-unavailable',
        1_250,
        'req-accepted-busy',
      ))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'watermark-held-local',
      didWrite: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-watermark-held',
        seq: 43,
        localId: 'watermark-held-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'watermark held prompt' },
            localId: 'watermark-held-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'watermark-held-local',
      deliveryState,
    });

    vi.useFakeTimers();
    catchUpMock.mockClear();
    fetchSnapshotMock.mockClear();
    listProviderDeliveryLocalIdsMock.mockClear();
    listDeliveryStatusesMock.mockClear();
    enqueueSessionTurnMock.mockClear();
    supervisorReportProbeResultMock.mockClear();
    sessionSocketStub?.connect.mockClear();
    sessionSocketStub?.disconnect.mockClear();
    sessionSocketStub?.close.mockClear();
    userSocketStub?.connect.mockClear();
    userSocketStub?.disconnect.mockClear();
    userSocketStub?.close.mockClear();

    confirmProviderInputAccepted(client, 'watermark-held-local');
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();
    expect(userSocketStub?.connect).not.toHaveBeenCalled();
    expect(userSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(userSocketStub?.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_249);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenLastCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'watermark-held-local',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();

  });

  it('abandons the operation-local accepted settlement retry when its originating runtime is replaced', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('runtime-fenced-settlement'));
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'runtime-fenced-settlement');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    client.beginRuntimeTermination();
    await vi.advanceTimersByTimeAsync(1_250);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('runtime-fenced-settlement')).toBe(true);
  });

  it('rejoins the same operation after a socket ACK timeout without granting unrelated wakes retry authority', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('ack-timeout-settlement'));
    const timeoutError = Object.assign(new Error('socket acknowledgement timed out'), {
      code: 'socket_ack_timeout' as const,
      retryable: true as const,
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
        message: {
          ...createProviderDeliveryMaterializeResult('ack-timeout-settlement').message,
          id: 'committed-ack-timeout-settlement',
          seq: 43,
          deliveryState: null,
        },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'ack-timeout-settlement');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'unrelated-pending-wake-during-ack-timeout',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('ack-timeout-settlement')).toBe(false);
  });

  it('caps response-loss settlement at one same-operation rejoin and never redrives it from wake or reconnect', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('bounded-rejoin-local'));
    const timeoutError = Object.assign(new Error('socket acknowledgement timed out'), {
      code: 'socket_ack_timeout' as const,
      retryable: true as const,
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    vi.useFakeTimers();
    confirmProviderInputAccepted(client, 'bounded-rejoin-local');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'bounded-rejoin-wake',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    if (!supervisorOnConnected) throw new Error('missing supervised reconnect callback');
    await supervisorOnConnected();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('bounded-rejoin-local')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('parks a generic accepted-settlement 500 with correlated diagnostics and no socket teardown', async () => {
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('generic-500-local'));
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(
      new PendingQueueAcceptedSettlementError('internal', undefined, 'req-post-callback-500'),
    );

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'generic-500-local',
    });

    vi.useFakeTimers();
    catchUpMock.mockClear();
    fetchSnapshotMock.mockClear();
    listProviderDeliveryLocalIdsMock.mockClear();
    listDeliveryStatusesMock.mockClear();
    enqueueSessionTurnMock.mockClear();
    supervisorReportProbeResultMock.mockClear();
    sessionSocketStub?.connect.mockClear();
    sessionSocketStub?.disconnect.mockClear();
    sessionSocketStub?.close.mockClear();

    confirmProviderInputAccepted(client, 'generic-500-local');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledWith(
      '[pendingQueue] accepted provider delivery resolution failed',
      expect.objectContaining({
        sessionId: 's1',
        localId: 'generic-500-local',
        error: expect.objectContaining({
          code: 'pending_queue_accepted_settlement_failed',
          settlementError: 'internal',
          correlationId: 'req-post-callback-500',
        }),
      }),
    );
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect(catchUpMock).not.toHaveBeenCalled();
    expect(fetchSnapshotMock).not.toHaveBeenCalled();
    expect(listProviderDeliveryLocalIdsMock).not.toHaveBeenCalled();
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
    expect(enqueueSessionTurnMock).not.toHaveBeenCalled();
    expect(supervisorReportProbeResultMock).not.toHaveBeenCalled();
    expect(sessionSocketStub?.connect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.disconnect).not.toHaveBeenCalled();
    expect(sessionSocketStub?.close).not.toHaveBeenCalled();
  });

  it('delivers provider-claimed pending rows directly without a committed transcript seq', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt' },
          localId: 'claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(resolveAcceptedPendingDeliveryMock).not.toHaveBeenCalled();

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-claimed-provider-local',
        seq: 43,
        localId: 'claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    confirmProviderInputAccepted(client, 'claimed-provider-local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'claimed-provider-local',
    });
    expect(hasProviderInputAcceptance(client, 'claimed-provider-local')).toBe(true);
    expect(client.getCommittedUserMessageSeq('claimed-provider-local')).toBe(43);
  });


  it('waits for in-flight accepted pending-delivery resolution before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-drain-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-drain-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before close' },
            localId: 'close-drain-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-drain-provider-local',
      deliveryState,
    });

    const acceptedWrite = createDeferred<void>();
    resolveAcceptedPendingDeliveryMock.mockImplementationOnce(async () => {
      await acceptedWrite.promise;
      return {
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
        message: {
          id: 'm-close-drain-provider-local',
          seq: 43,
          localId: 'close-drain-provider-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'claimed provider prompt before close' },
              localId: 'close-drain-provider-local',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      };
    });

    confirmProviderInputAccepted(client, 'close-drain-provider-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    let closeSettled = false;
    const closePromise = client.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closeSettled).toBe(false);

    acceptedWrite.resolve();
    await closePromise;
    expect(closeSettled).toBe(true);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('does not block provider-accepted pending delivery on close when accepted resolution is still failing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-accepted-retry-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-accepted-retry-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'accepted prompt with temporary resolution failure' },
            localId: 'close-accepted-retry-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted resolution failure'))
      .mockRejectedValueOnce(new Error('still temporarily unavailable'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-accepted-retry-local',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'close-accepted-retry-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    (client as any).rpcLifecycleRegistrations.splice(0);

    await client.close();

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('blocks unresolved provider-claimed pending deliveries before closing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    client.onUserMessage(() => {});
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before runner exit' },
            localId: 'close-block-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-provider-local',
      deliveryState,
    });

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks unresolved provider-custody rows discovered from durable state during close', async () => {
    const { logger } = await import('@/ui/logger');
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    listProviderDeliveryLocalIdsMock.mockResolvedValueOnce(['close-durable-provider-local']);
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 2,
      },
    });

    try {
      await client.close();

      expect(listProviderDeliveryLocalIdsMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
      });
      expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
        localId: 'close-durable-provider-local',
        reason: 'runtime_disposed_before_delivery',
      });
      expect(debugSpy.mock.calls.some(([message, payload]) =>
        String(message) === '[pendingQueue] provider delivery block succeeded'
        && (payload as any)?.sessionId === 's1'
        && (payload as any)?.localId === 'close-durable-provider-local'
        && (payload as any)?.reason === 'runtime_disposed_before_delivery'
      )).toBe(true);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('blocks delivered provider-claimed pending rows before closing when materialization omits delivery state', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-legacy-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'close-block-legacy-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
            localId: 'close-block-legacy-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-legacy-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt before dispatch proof' },
          localId: 'close-block-legacy-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-legacy-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('blocks delivered uncommitted provider-claimed pending rows whose materialization includes an opaque id', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-opaque-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-pending-materialization-id',
        seq: null,
        localId: 'close-block-opaque-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
            localId: 'close-block-opaque-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-opaque-provider-local',
      seq: null,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with opaque id before dispatch proof' },
          localId: 'close-block-opaque-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-opaque-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('normalizes contradictory resolved provider state on delivered uncommitted provider claims', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'close-block-resolved-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'opaque-resolved-provider-materialization-id',
        seq: null,
        localId: 'close-block-resolved-provider-local',
        messageRole: 'user',
        deliveryState: { mode: 'provider' as const, unresolved: false },
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
            localId: 'close-block-resolved-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    const normalizedDeliveryState = { mode: 'provider', unresolved: true };
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'close-block-resolved-provider-local',
      seq: null,
      deliveryState: normalizedDeliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with stale resolved state' },
          localId: 'close-block-resolved-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);

    await client.close();

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'close-block-resolved-provider-local',
      reason: 'runtime_disposed_before_delivery',
    });
  });

  it('uses the materialization ack localId for provider-claimed rows whose nested message omits it', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'top-level-claimed-provider-local',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: null,
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'top-level-claimed-provider-local',
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
          localId: 'top-level-claimed-provider-local',
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-top-level-claimed-provider-local',
        seq: 44,
        localId: 'top-level-claimed-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt with top-level local id only' },
            localId: 'top-level-claimed-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1001,
        updatedAt: 1001,
      },
    });

    confirmProviderInputAccepted(client, 'top-level-claimed-provider-local');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'top-level-claimed-provider-local',
    });
    expect(hasProviderInputAcceptance(client, 'top-level-claimed-provider-local')).toBe(true);
    expect(client.getCommittedUserMessageSeq('top-level-claimed-provider-local')).toBe(44);
  });

  it('blocks malformed provider-delivery materialization metadata instead of dropping the row locally', async () => {
    const localId = 'malformed-provider-delivery-local';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: unknown[] = [];
    client.onUserMessage((message) => delivered.push(message));
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: 'user',
        deliveryStateMalformed: true,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'malformed provider delivery metadata prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(delivered).toEqual([]);
    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId,
      reason: 'unknown',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('delivers encrypted provider-claimed pending rows even when server role metadata is missing', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const localId = 'encrypted-claimed-provider-local';
    const encryptionKey = new Uint8Array(32);
    const client = await createClient({
      encryptionMode: 'e2ee',
      encryptionKey,
      encryptionVariant: 'legacy',
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: Array<{ message: unknown; info: unknown }> = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId,
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId,
        messageRole: null,
        deliveryState,
        content: {
          t: 'encrypted',
          c: encodeBase64(encrypt(encryptionKey, 'legacy', {
            role: 'user',
            content: { type: 'text', text: 'encrypted claimed provider prompt' },
            localId,
            meta: { source: 'ui', sentFrom: 'web' },
          })),
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: null,
      deliveryState,
    });
    expect(delivered).toEqual([
      {
        message: {
          role: 'user',
          content: { type: 'text', text: 'encrypted claimed provider prompt' },
          localId,
          meta: { source: 'ui', sentFrom: 'web' },
          createdAt: 1000,
        },
        info: { seq: null, providerAcceptancePending: true },
      },
    ]);
    expect(blockPendingDeliveryMock).not.toHaveBeenCalled();
  });

  it('clears accepted canonical pending delivery so later pending rows can materialize', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-provider-1',
          seq: 51,
          localId: 'provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first prompt' },
              localId: 'provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-provider-2',
          seq: 52,
          localId: 'provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second prompt' },
              localId: 'provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    confirmProviderInputAccepted(client, 'provider-m1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retires exact local custody after manual handling deletes the server row and materializes the later row once', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const providerInvocations: string[] = [];
    client.onUserMessage((message) => {
      if (message.localId) providerInvocations.push(message.localId);
    });
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('manual-handled-local', 2))
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult('later-local', 4),
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 4 },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'manual-handled-local',
    });
    expect(providerInvocations).toEqual(['manual-handled-local']);

    // The exact first row was resolved with manual_handled and deleted. The later row remains.
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'later-local', status: 'queued' },
    ]);
    await client.reconcilePendingQueueState({ force: true });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'later-local',
    });

    expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);
    expect(listDeliveryStatusesMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect(providerInvocations).toEqual(['manual-handled-local', 'later-local']);
    expect(hasProviderInputAcceptance(client, 'manual-handled-local')).toBe(false);
  });

  it('retires an exact discarded server row without manufacturing provider input or acceptance', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const providerInvocations: string[] = [];
    client.onUserMessage((message) => {
      if (message.localId) providerInvocations.push(message.localId);
    });
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('discarded-local', 2))
      .mockResolvedValueOnce({
        didMaterialize: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(providerInvocations).toEqual(['discarded-local']);
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'discarded-local', status: 'discarded' },
    ]);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(providerInvocations).toEqual(['discarded-local']);
    expect(hasProviderInputAcceptance(client, 'discarded-local')).toBe(false);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('discarded-local')).toBe(false);
  });

  it.each(['queued', 'delivering', 'blocked'] as const)(
    'retains exact local custody while the server row remains %s',
    async (status) => {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: { deliveredUserMessageSeqV1: 0 },
      });
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(`unresolved-${status}`, 2));

      await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
      listDeliveryStatusesMock.mockResolvedValueOnce([
        { localId: `unresolved-${status}`, status },
      ]);

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
        type: 'no_pending',
      });

      expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
      expect((client as any).canonicalPendingDeliveryByLocalId.has(`unresolved-${status}`)).toBe(true);
    },
  );

  it('retains exact local custody when the bounded status reconciliation fails', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('status-network-failure', 2));

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    listDeliveryStatusesMock.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(listDeliveryStatusesMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('status-network-failure')).toBe(true);
  });

  it('does not retire exact local custody from a terminal status belonging to another localId', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('exact-live-local', 2));

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'wrong-terminal-local', status: 'discarded' },
      { localId: 'exact-live-local', status: 'delivering' },
    ]);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });

    expect(materializeNextMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('exact-live-local')).toBe(true);
  });

  it('retains canonical ownership and progress when accepted delivery is a server no-op', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 3,
      },
    });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'provider-noop', status: 'blocked' },
    ]);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'provider-noop',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'provider-noop',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'provider no-op prompt' },
            localId: 'provider-noop',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-noop',
      deliveryState,
    });
    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-noop')).toBe(true);

    confirmProviderInputAccepted(client, 'provider-noop');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-noop')).toBe(true);
  });

  it('does not grant a delivery-status snapshot retry authority after a settlement no-op', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('non-authoritative-status'));
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    listDeliveryStatusesMock.mockRejectedValueOnce(
      new Error('Invalid pending queue delivery status projection'),
    );

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'non-authoritative-status');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('non-authoritative-status')).toBe(true);
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
  });

  it('retains an accepted claim after a settlement no-op without starting an independent absence transaction', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    materializeNextMock.mockResolvedValueOnce({
      didMaterialize: true,
      localId: 'provider-idempotent',
      didWrite: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: {
        id: null,
        seq: null,
        localId: 'provider-idempotent',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'provider idempotent prompt' },
            localId: 'provider-idempotent',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'provider-idempotent');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((client as any).canonicalPendingDeliveryByLocalId.has('provider-idempotent')).toBe(true);
    expect(listDeliveryStatusesMock).not.toHaveBeenCalled();
  });

  it('keeps later materialization blocked after a permanent accepted-settlement failure', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary resolution failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    listDeliveryStatusesMock.mockResolvedValue([
      { localId: 'retry-provider-m1', status: 'delivering' },
    ]);
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-provider-1',
          seq: 61,
          localId: 'retry-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first retry prompt' },
              localId: 'retry-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-provider-2',
          seq: 62,
          localId: 'retry-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'second retry prompt' },
              localId: 'retry-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-provider-m1',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'retry-provider-m1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a newer pending-change wake retry accepted-delivery settlement', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-on-pending-change'));
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted-resolution failure'))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'retry-on-pending-change');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'accepted-resolution-pending-change',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-on-pending-change')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not let turn end retry a live didResolve false settlement', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-noop-on-turn-end'));
    resolveAcceptedPendingDeliveryMock
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
      })
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
      });
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'retry-noop-on-turn-end', status: 'blocked' },
    ]);

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'retry-noop-on-turn-end');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-noop-on-turn-end')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not let reconnect retry accepted-delivery settlement', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult('retry-on-reconnect'));
    resolveAcceptedPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary accepted-resolution failure'))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'retry-on-reconnect');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    if (!supervisorOnConnected) throw new Error('missing supervised reconnect callback');
    await supervisorOnConnected();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('retry-on-reconnect')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a wake consumed by a successful resolution for a later failed acceptance', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    const firstResolution = createDeferred<any>();
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('wake-success-first', 2))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('wake-failure-second', 4));
    resolveAcceptedPendingDeliveryMock
      .mockImplementationOnce(() => firstResolution.promise)
      .mockRejectedValueOnce(new Error('later accepted-resolution failure'))
      .mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 6 },
      });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'wake-success-first');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    if (!userSocketStub) throw new Error('missing user socket');
    userSocketStub.trigger('update', {
      id: 'wake-during-successful-resolution',
      createdAt: Date.now(),
      body: {
        t: 'pending-changed',
        sid: 's1',
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    firstResolution.resolve({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has('wake-success-first') === false);

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, 'wake-failure-second');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('wake-failure-second')).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('retires an accepted-delivery claim after not-found plus exact authoritative absence without manufacturing acceptance', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    resolveAcceptedPendingDeliveryMock.mockRejectedValue(
      new PendingQueueAcceptedSettlementError('not-found'),
    );
    fetchSnapshotMock.mockResolvedValue({
      pendingQueueState: {
        known: true,
        pendingCount: 1,
        pendingBlockedCount: 0,
        pendingVersion: 3,
      },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-stale-accepted-provider-1',
          seq: 71,
          localId: 'stale-accepted-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'first stale accepted prompt' },
              localId: 'stale-accepted-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-accepted-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-stale-accepted-provider-2',
          seq: 72,
          localId: 'stale-accepted-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale accepted claim' },
              localId: 'stale-accepted-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-accepted-provider-m1',
      deliveryState,
    });

    confirmProviderInputAccepted(client, 'stale-accepted-provider-m1');
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-accepted-provider-m2',
    });
    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect((client as any).canonicalPendingDeliveryByLocalId.has('stale-accepted-provider-m1')).toBe(false);
    expect(hasProviderInputAcceptance(client, 'stale-accepted-provider-m1')).toBe(false);
  });

  it('retires an accepted-delivery claim only from the exact committed replay identity and seq', async () => {
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(' replay-proof-local '));
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      message: {
        id: 'm-replay-proof',
        seq: 73,
        localId: ' replay-proof-local ',
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'replayed' } } },
        createdAt: 1_000,
        updatedAt: 1_001,
        deliveryState: null,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    confirmProviderInputAccepted(client, ' replay-proof-local ');
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(' replay-proof-local ') === false);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(hasProviderInputAcceptance(client, ' replay-proof-local ')).toBe(true);
    expect(client.getCommittedUserMessageSeq(' replay-proof-local ')).toBe(73);
    expect(client.getCommittedUserMessageSeq('replay-proof-local')).toBeNull();
  });

  it('retires accepted canonical custody when the exact committed transcript arrives after settlement response loss', async () => {
    const localId = 'accepted-response-loss-transcript-proof';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId))
      .mockResolvedValueOnce(createProviderDeliveryMaterializeResult('next-after-transcript-proof'));
    resolveAcceptedPendingDeliveryMock.mockRejectedValueOnce(new Error('operation has timed out'));

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
    });
    confirmProviderInputAccepted(client, localId);
    await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);

    triggerCommittedUserMessage({ seq: 73, localId: 'neighbor-transcript-row' });
    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(true);

    triggerCommittedUserMessage({ seq: 74, localId });

    expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(false);
    expect(client.getCommittedUserMessageSeq(localId)).toBe(74);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'next-after-transcript-proof',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('blocks server-owned provider delivery after a terminal pre-write payload rejection', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
    });
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-too-large-provider-1',
          seq: 71,
          localId: 'too-large-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'oversized prompt' },
              localId: 'too-large-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'too-large-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-too-large-provider-2',
          seq: 72,
          localId: 'too-large-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt' },
              localId: 'too-large-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m1',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.blockPendingMessageDelivery({
      localIds: ['too-large-provider-m1'],
      reason: 'payload_too_large',
    })).resolves.toBe(true);

    expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
      token: 'tok',
      sessionId: 's1',
      localId: 'too-large-provider-m1',
      reason: 'payload_too_large',
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'too-large-provider-m2',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it('allows a later exact action after an uncertain claim is durably blocked while retaining late acceptance identity', async () => {
    const uncertainLocalId = 'uncertain-blocked-original';
    const replacementLocalId = 'uncertain-send-as-new-replacement';
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 2,
      pendingBlockedCount: 0,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(client);
    materializeNextMock
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult(uncertainLocalId, 2),
        pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 2 },
      })
      .mockResolvedValueOnce({
        ...createProviderDeliveryMaterializeResult(replacementLocalId, 4),
        pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 4 },
      });
    blockPendingDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 1, pendingVersion: 3 },
    });
    resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
      message: {
        id: `message-${uncertainLocalId}`,
        seq: 91,
        localId: uncertainLocalId,
        messageRole: 'user',
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `prompt ${uncertainLocalId}` } } },
        createdAt: 1_000,
        updatedAt: 1_001,
        deliveryState: null,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: uncertainLocalId,
    });
    await expect(client.blockPendingMessageDelivery({
      localIds: [uncertainLocalId],
      reason: 'ambiguous_terminal_delivery',
    })).resolves.toBe(true);

    expect((client as any).canonicalPendingDeliveryByLocalId.has(uncertainLocalId)).toBe(true);
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: replacementLocalId,
    });

    confirmProviderInputAccepted(client, uncertainLocalId);
    await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(uncertainLocalId) === false);

    expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: uncertainLocalId,
    });
    expect((client as any).canonicalPendingDeliveryByLocalId.has(replacementLocalId)).toBe(true);
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)(
    'retains the exact live provider claim through reversible %s blocking so late acceptance settles the row',
    async (reason) => {
      const localId = `reversible-${reason}`;
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
        metadata: { deliveredUserMessageSeqV1: 0 },
      });
      await waitForCurrentPendingInputContract(client);
      materializeNextMock.mockResolvedValueOnce(createProviderDeliveryMaterializeResult(localId));
      blockPendingDeliveryMock.mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 3 },
      });
      resolveAcceptedPendingDeliveryMock.mockResolvedValueOnce({
        didResolve: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 4 },
        message: {
          id: `message-${localId}`,
          seq: 91,
          localId,
          messageRole: 'user',
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `prompt ${localId}` } } },
          createdAt: 1_000,
          updatedAt: 1_001,
          deliveryState: null,
        },
      });

      await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
        type: 'materialized',
        localId,
      });
      await expect(client.blockPendingMessageDelivery({ localIds: [localId], reason })).resolves.toBe(true);

      expect(blockPendingDeliveryMock).toHaveBeenCalledWith({
        token: 'tok',
        sessionId: 's1',
        localId,
        reason,
      });
      expect((client as any).canonicalPendingDeliveryByLocalId.has(localId)).toBe(true);
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);

      confirmProviderInputAccepted(client, localId);
      await waitUntil(() => resolveAcceptedPendingDeliveryMock.mock.calls.length === 1);
      await waitUntil(() => (client as any).canonicalPendingDeliveryByLocalId.has(localId) === false);

      expect(resolveAcceptedPendingDeliveryMock).toHaveBeenCalledWith({
        socket: sessionSocketStub,
        sessionId: 's1',
        localId,
      });
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);
      expect(materializeNextMock).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the canonical claim when the server block write fails without redriving it', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock
      .mockRejectedValueOnce(new Error('temporary block failure'))
      .mockResolvedValueOnce({
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 3 },
      });
    listDeliveryStatusesMock.mockResolvedValue([
      { localId: 'retry-block-provider-m1', status: 'delivering' },
    ]);
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-retry-block-provider-1',
          seq: 81,
          localId: 'retry-block-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt to block' },
              localId: 'retry-block-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'retry-block-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-retry-block-provider-2',
          seq: 82,
          localId: 'retry-block-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after block retry' },
              localId: 'retry-block-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'retry-block-provider-m1',
      deliveryState,
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['retry-block-provider-m1'],
      reason: 'runtime_disposed_before_delivery',
    })).resolves.toBe(true);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('retires a stale blocked-delivery claim after exact authoritative absence without manufacturing acceptance', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    blockPendingDeliveryMock.mockRejectedValue(createPendingDeliveryHttpError(404, 'not-found'));
    materializeNextMock
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-block-provider-m1',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 1, pendingVersion: 2 },
        message: {
          id: 'm-stale-block-provider-1',
          seq: 81,
          localId: 'stale-block-provider-m1',
          messageRole: 'user',
          deliveryState,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'provider prompt whose block is stale' },
              localId: 'stale-block-provider-m1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1000,
          updatedAt: 1000,
        },
      })
      .mockResolvedValueOnce({
        didMaterialize: true,
        localId: 'stale-block-provider-m2',
        didWrite: true,
        pendingQueueState: { known: true, pendingCount: 0, pendingVersion: 4 },
        message: {
          id: 'm-stale-block-provider-2',
          seq: 82,
          localId: 'stale-block-provider-m2',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'next prompt after stale block claim' },
              localId: 'stale-block-provider-m2',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 1001,
          updatedAt: 1001,
        },
      });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'stale-block-provider-m1',
      deliveryState,
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['stale-block-provider-m1'],
      reason: 'runtime_disposed_before_delivery',
    })).resolves.toBe(false);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);

    listDeliveryStatusesMock.mockResolvedValueOnce([]);
    const secondResult = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeNextMock).toHaveBeenCalledTimes(2);
    expect(secondResult).toMatchObject({
      type: 'materialized',
      localId: 'stale-block-provider-m2',
    });
    expect(blockPendingDeliveryMock).toHaveBeenCalledTimes(1);
    expect(hasProviderInputAcceptance(client, 'stale-block-provider-m1')).toBe(false);
  });

  it('does not use turn-end catch-up as a hidden transcript queue for canonical pending deliveries', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    // The provider-delivery row is still delivering server-side (single delivery truth).
    listDeliveryStatusesMock.mockResolvedValue([{ localId: 'canonical-pending-local', status: 'delivering' }]);
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'canonical-pending-local',
      didWrite: true,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-canonical-pending',
        seq: 44,
        localId: 'canonical-pending-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'canonical pending prompt' },
            localId: 'canonical-pending-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(delivered).toHaveLength(1);

    await client.sessionTurnLifecycle.beginTurn({ provider: 'claude' });
    catchUpMock.mockClear();
    await client.sessionTurnLifecycle.completeTurn({ provider: 'claude' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(catchUpMock).not.toHaveBeenCalled();
  });

  it('does not invoke provider input from delayed transcript catch-up after a Queue V2 handoff and runner restart', async () => {
    const localId = 'queue-owned-restart-local';
    const providerInvocations: string[] = [];
    const firstClient = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    await waitForCurrentPendingInputContract(firstClient);
    firstClient.onUserMessage((message) => {
      providerInvocations.push(message.content.text);
    });
    materializeNextMock.mockResolvedValue(createProviderDeliveryMaterializeResult(localId));

    await expect(firstClient.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId,
      seq: null,
    });
    expect(providerInvocations).toEqual([`prompt ${localId}`]);
    await firstClient.close();

    const delayedTranscriptUpdate = {
      id: `catchup-message-${localId}`,
      createdAt: 2_000,
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: `message-${localId}`,
          seq: 44,
          localId,
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: `prompt ${localId}` },
              localId,
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          createdAt: 2_000,
          updatedAt: 2_000,
        },
      },
    };
    const replacementClient = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 0,
      pendingVersion: 3,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    replacementClient.onUserMessage((message) => {
      providerInvocations.push(message.content.text);
    });
    (replacementClient as unknown as {
      handleUpdate(
        update: unknown,
        opts: {
          source: 'session-scoped';
          catchUpAfterSeq: number;
          catchUpAuthorization: 'explicit_cursor';
        },
      ): void;
    }).handleUpdate(delayedTranscriptUpdate, {
      source: 'session-scoped',
      catchUpAfterSeq: 0,
      catchUpAuthorization: 'explicit_cursor',
    });

    expect(providerInvocations).toEqual([`prompt ${localId}`]);
  });

  it('does not loop materializing the same queued provider-delivery localId while it remains unresolved', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    // The provider-delivery row is still delivering server-side (single delivery truth).
    listDeliveryStatusesMock.mockResolvedValue([{ localId: 'repeat-provider-local', status: 'delivering' }]);
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'repeat-provider-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-repeat-provider',
        seq: 45,
        localId: 'repeat-provider-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'repeat provider prompt' },
            localId: 'repeat-provider-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'repeat-provider-local',
      deliveryState,
    });
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({
      type: 'no_pending',
    });
    expect(materializeNextMock).toHaveBeenCalledTimes(1);
  });

  it('tracks provider-claimed materialized localIds for provider-acceptance cleanup', async () => {
    const deliveryState = { mode: 'provider' as const, unresolved: true };
    const client = await createClient({
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingVersion: 1,
      metadata: { deliveredUserMessageSeqV1: 0 },
    });
    const delivered: unknown[] = [];
    client.onUserMessage((message, info) => delivered.push({ message, info }));
    materializeNextMock.mockResolvedValue({
      didMaterialize: true,
      localId: 'provider-claim-local',
      didWrite: false,
      pendingQueueState: { pendingCount: 1, pendingVersion: 2 },
      message: {
        id: 'm-provider-claim',
        seq: null,
        localId: 'provider-claim-local',
        messageRole: 'user',
        deliveryState,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'claimed provider prompt' },
            localId: 'provider-claim-local',
            meta: { source: 'ui', sentFrom: 'web' },
          },
        },
        createdAt: 1000,
        updatedAt: 1000,
      },
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'provider-claim-local',
      seq: null,
      deliveryState,
    });

    expect(delivered).toHaveLength(1);
    expect(
      (client as unknown as { hasPendingQueueMaterializedLocalId(localId: string): boolean })
        .hasPendingQueueMaterializedLocalId('provider-claim-local'),
    ).toBe(true);
  });

  it('still materializes on the exact connected session socket while its supervisor is reconnecting', async () => {
    supervisorPhase = 'connecting';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });
      materializeNextMock.mockResolvedValue({ didMaterialize: false });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result.type).not.toBe('deferred');
      expect(materializeNextMock).toHaveBeenCalledWith(expect.objectContaining({ socket: sessionSocketStub }));
    } finally {
      supervisorPhase = 'online';
    }
  });

  it('returns typed auth failure while the supervisor is auth_failed', async () => {
    supervisorPhase = 'auth_failed';
    try {
      const client = await createClient({
        latestTurnStatus: 'completed',
        pendingCount: 1,
        pendingVersion: 1,
      });

      const result = await client.materializeNextPendingMessageSafely();

      expect(result).toEqual({ type: 'auth_failure', statusCode: 401 });
      expect(materializeNextMock).not.toHaveBeenCalled();
    } finally {
      supervisorPhase = 'online';
    }
  });

});
