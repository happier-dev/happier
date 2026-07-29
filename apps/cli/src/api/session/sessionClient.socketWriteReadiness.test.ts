import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import {
  createApiSessionSocketStub,
  type ApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { ApiSessionClient } from './sessionClient';
import {
  createRegisteredSessionStateFieldMutation,
} from './client/transport/mutations/sessionClientDurableMutationTypes';

const ownerCredentials = {
  token: 'tok',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array(32).fill(4),
  },
};

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

type MockConnectionState = Readonly<{
  phase: string;
  reason: string | null;
  attempt: number;
  nextRetryAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  lastErrorMessage: string | null;
}>;

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const harness = vi.hoisted(() => ({
  sessionSocket: null as ApiSessionSocketStub | null,
  userSocket: null as ApiSessionSocketStub | null,
  startDeferred: null as Deferred | null,
  fetchSessionByIdCompat: vi.fn(),
  patchMetadataEnvelopeTuple: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: harness.fetchSessionByIdCompat,
  patchSessionMetadataEnvelopeTuple: harness.patchMetadataEnvelopeTuple,
}));

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!harness.userSocket) throw new Error('Missing user socket stub');
    return harness.userSocket as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!harness.sessionSocket) throw new Error('Missing session socket stub');
    return {
      socket: harness.sessionSocket as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => harness.sessionSocket?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: {
    createTransport: () => unknown;
    onStateChange?: (state: MockConnectionState) => void;
  }) => {
    let startPromise: Promise<void> | null = null;
    let state: MockConnectionState = {
      phase: 'idle',
      reason: null,
      attempt: 0,
      nextRetryAt: null,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastErrorMessage: null,
    };

    return {
      getState: () => state,
      reportProbeResult: vi.fn(),
      start: () => {
        if (!startPromise) {
          startPromise = (async () => {
            state = { ...state, phase: 'connecting' };
            params.onStateChange?.(state);
            params.createTransport();
            if (!harness.startDeferred) throw new Error('Missing start deferred');
            await harness.startDeferred.promise;
            if (harness.sessionSocket) {
              harness.sessionSocket.connected = true;
            }
            state = { ...state, phase: 'online', lastConnectedAt: Date.now() };
            params.onStateChange?.(state);
          })();
        }
        return startPromise;
      },
      stop: async () => {},
    };
  },
}));

describe('ApiSessionClient socket write readiness', () => {
  beforeEach(() => {
    harness.fetchSessionByIdCompat.mockReset();
    harness.patchMetadataEnvelopeTuple.mockReset();
  });

  it('keeps ordinary layout-0 metadata on the legacy socket owner', async () => {
    harness.startDeferred = createDeferred();
    harness.startDeferred.resolve();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'update-metadata') {
          throw new Error(`unexpected event ${event}`);
        }
        const request = payload as {
          expectedVersion: number;
          metadata: string;
        };
        return {
          result: 'success',
          version: request.expectedVersion + 1,
          metadata: request.metadata,
        };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const session = createPlainSessionFixture({ id: 's-ready-metadata' });
    harness.fetchSessionByIdCompat.mockResolvedValue({
      ...session,
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata ?? {}),
      ownerMetadata: null,
      agentState: session.agentState === null
        ? null
        : JSON.stringify(session.agentState),
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    const client = new ApiSessionClient(
      'tok',
      session,
      { credentials: ownerCredentials },
    );
    const updater = vi.fn((metadata) => ({
      ...metadata,
      summary: { text: 'startup ready', updatedAt: 1 },
    }));

    await client.updateMetadata(updater);

    expect(updater).toHaveBeenCalledTimes(1);
    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith(
      'update-metadata',
      expect.objectContaining({
        sid: 's-ready-metadata',
        expectedVersion: session.metadataVersion,
        metadata: expect.stringContaining('startup ready'),
      }),
    );
    expect(harness.patchMetadataEnvelopeTuple).not.toHaveBeenCalled();
  });

  it('keeps ordinary layout-0 AgentState on the legacy socket owner', async () => {
    harness.startDeferred = createDeferred();
    harness.startDeferred.resolve();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload) => {
        if (event !== 'update-state') {
          throw new Error(`unexpected event ${event}`);
        }
        const request = payload as {
          expectedVersion: number;
          agentState: string;
        };
        return {
          result: 'success',
          version: request.expectedVersion + 1,
          agentState: request.agentState,
        };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const session = createPlainSessionFixture({ id: 's-ready-state' });
    harness.fetchSessionByIdCompat.mockResolvedValue({
      ...session,
      metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata ?? {}),
      ownerMetadata: null,
      agentState: session.agentState === null
        ? null
        : JSON.stringify(session.agentState),
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    const client = new ApiSessionClient(
      'tok',
      session,
      { credentials: ownerCredentials },
    );
    const updater = vi.fn((agentState) => ({ ...agentState, startupReady: true }));

    await client.updateAgentState(updater);

    expect(updater).toHaveBeenCalledTimes(1);
    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith(
      'update-state',
      expect.objectContaining({
        sid: 's-ready-state',
        expectedVersion: session.agentStateVersion,
        agentState: expect.stringContaining('startupReady'),
      }),
    );
    expect(harness.patchMetadataEnvelopeTuple).not.toHaveBeenCalled();
  });

  it('writes layout-1 metadata and AgentState through HTTP without waiting for or using the socket', async () => {
    harness.startDeferred = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({ connected: false });
    harness.userSocket = createApiSessionSocketStub({ connected: true });
    harness.patchMetadataEnvelopeTuple
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 2 },
        agentState: { version: 3 },
      })
      .mockResolvedValueOnce({
        success: true,
        metadataLayoutVersion: 1,
        sharedMetadata: { version: 3 },
        agentState: { version: 4 },
      });

    const legacySession = createPlainSessionFixture({ id: 's-layout-one' });
    const tuple = buildSessionMetadataEnvelopeFields({
      credentials: ownerCredentials,
      metadata: legacySession.metadata ?? {},
      agentState: legacySession.agentState,
      storedContentMode: 'plain',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy',
    });
    const client = new ApiSessionClient(
      'tok',
      {
        ...legacySession,
        metadataLayoutVersion: 1,
        metadata: legacySession.metadata,
        metadataVersion: 1,
        ownerMetadata: tuple.ownerMetadataValue,
        ownerMetadataCiphertext: tuple.ownerMetadata.ciphertext,
        agentStateVersion: 2,
      },
      { credentials: ownerCredentials },
    );

    harness.fetchSessionByIdCompat.mockResolvedValueOnce({
      ...legacySession,
      metadataLayoutVersion: 1,
      metadata: tuple.sharedMetadata.ciphertext,
      metadataVersion: 1,
      ownerMetadata: tuple.ownerMetadata.ciphertext,
      agentState: tuple.agentState,
      agentStateVersion: 2,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    await client.updateMetadata((metadata) => ({
      ...metadata,
      summary: { text: 'HTTP tuple', updatedAt: 2 },
    }));
    const metadataPatch =
      harness.patchMetadataEnvelopeTuple.mock.calls[0]?.[0]?.patch;
    if (!metadataPatch || metadataPatch.mode !== 'owner') {
      throw new Error('Expected owner tuple metadata patch');
    }
    harness.fetchSessionByIdCompat.mockResolvedValueOnce({
      ...legacySession,
      metadataLayoutVersion: 1,
      metadata: metadataPatch.sharedMetadata.ciphertext,
      metadataVersion: 2,
      ownerMetadata: metadataPatch.ownerMetadata.ciphertext,
      agentState: metadataPatch.agentState.ciphertext,
      agentStateVersion: 3,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    });
    await client.updateAgentState((agentState) => ({
      ...agentState,
      startupReady: true,
    }));

    expect(harness.patchMetadataEnvelopeTuple).toHaveBeenCalledTimes(2);
    expect(harness.patchMetadataEnvelopeTuple).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok',
        sessionId: 's-layout-one',
        patch: expect.objectContaining({
          mode: 'owner',
          metadataLayoutVersion: 1,
        }),
      }),
    );
    expect(harness.sessionSocket.emitWithAck).not.toHaveBeenCalled();
  });

  it('delays runtime activity projection writes until the managed session socket is online', async () => {
    harness.startDeferred = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: false,
      emitWithAck: async (event, payload: any) => {
        if (event === 'runtime-activity-snapshot') {
          return {
            result: 'success',
            didWrite: true,
            runtimeActivityState: payload.state,
            runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
            runtimeActivityObservedAt: 1_000,
            runtimeActivityRevision: 1,
          };
        }
        return { result: 'success' };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's-ready-runtime-activity' }));

    const updatePromise = client.updateRuntimeActivityProjection({
      runtimeActivityState: 'active',
      runtimeActivityActiveCount: 1,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.sessionSocket.emitWithAck).not.toHaveBeenCalled();

    harness.startDeferred.resolve();
    await expect.poll(() => harness.sessionSocket?.connected === true).toBe(true);
    await updatePromise;

    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith('runtime-activity-snapshot', {
      sid: 's-ready-runtime-activity',
      state: 'active',
      runtimeActivityActiveCount: 1,
    });
    expect(harness.sessionSocket.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-state');
    expect(harness.sessionSocket.emitWithAck.mock.calls.map((call) => call[0])).not.toContain('update-metadata');
    expect(harness.sessionSocket.emit).not.toHaveBeenCalledWith(
      'session-alive',
      expect.objectContaining({ thinking: true }),
    );
  });

  it('claims current publisher authority through the acknowledged Runtime Activity presence owner', async () => {
    harness.startDeferred = createDeferred();
    harness.startDeferred.resolve();
    const acknowledge = createDeferred();
    harness.sessionSocket = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload: any) => {
        if (event !== 'runtime-activity-snapshot') {
          return { result: 'success' };
        }
        await acknowledge.promise;
        return {
          result: 'success',
          didWrite: true,
          runtimeActivityState: payload.state,
          runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
          runtimeActivityObservedAt: 1_000,
          runtimeActivityRevision: 1,
        };
      },
    });
    harness.userSocket = createApiSessionSocketStub({ connected: true });
    const session = createPlainSessionFixture({ id: 's-startup-publisher-claim' });
    const client = new ApiSessionClient('tok', session, {
      initialRegisteredSessionStateFieldMutations: [
        createRegisteredSessionStateFieldMutation({
          sessionId: session.id,
          fieldId: 'runtime.activity',
          deliveryClass: 'durable_best_effort',
          source: 'runtime',
          op: {
            kind: 'set',
            value: { state: 'unknown', activeCount: 0 },
          },
        }),
      ],
      durableMutationDeliveryInitiallyActive: false,
    });
    (client as never as {
      sessionSyncPendingInputServerContractResult: unknown;
    }).sessionSyncPendingInputServerContractResult = {
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 1,
      socket: harness.sessionSocket,
    };

    let settled = false;
    const claim = client
      .claimCurrentSessionPublisherAuthorityForStartup()
      .then(() => {
        settled = true;
      });
    await expect.poll(() =>
      harness.sessionSocket?.emitWithAck.mock.calls.some(
        ([event]) => event === 'runtime-activity-snapshot',
      ),
    ).toBe(true);
    expect(settled).toBe(false);

    acknowledge.resolve();
    await claim;

    expect(harness.sessionSocket.emitWithAck).toHaveBeenCalledWith(
      'runtime-activity-snapshot',
      {
        sid: 's-startup-publisher-claim',
        state: 'unknown',
        runtimeActivityActiveCount: 0,
      },
    );
  });

  it('keeps ordinary released-v0.2.1 startup off the unsupported publisher-claim transport', async () => {
    harness.startDeferred = createDeferred();
    harness.startDeferred.resolve();
    harness.sessionSocket = createApiSessionSocketStub({ connected: true });
    harness.userSocket = createApiSessionSocketStub({ connected: true });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's-released-startup' }),
      { durableMutationDeliveryInitiallyActive: false },
    );
    (client as never as {
      sessionSyncPendingInputServerContractResult: unknown;
    }).sessionSyncPendingInputServerContractResult = {
      mode: 'released_server_v0_2_1',
      sessionConnectionEpoch: 1,
      socket: harness.sessionSocket,
    };

    await expect(
      client.claimCurrentSessionPublisherAuthorityForStartup(),
    ).resolves.toEqual({ status: 'unsupported' });

    expect(harness.sessionSocket.emitWithAck).not.toHaveBeenCalledWith(
      'runtime-activity-snapshot',
      expect.anything(),
    );
  });

  it('retries the startup publisher claim on the exact newly negotiated socket when its first ACK is superseded', async () => {
    harness.startDeferred = createDeferred();
    harness.startDeferred.resolve();
    const firstAcknowledge = createDeferred();
    const socketA = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload: any) => {
        if (event !== 'runtime-activity-snapshot') {
          return { result: 'success' };
        }
        await firstAcknowledge.promise;
        return {
          result: 'success',
          didWrite: true,
          runtimeActivityState: payload.state,
          runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
          runtimeActivityObservedAt: 1_000,
          runtimeActivityRevision: 1,
        };
      },
    });
    const socketB = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event, payload: any) => {
        if (event !== 'runtime-activity-snapshot') {
          return { result: 'success' };
        }
        return {
          result: 'success',
          didWrite: true,
          runtimeActivityState: payload.state,
          runtimeActivityActiveCount: payload.runtimeActivityActiveCount,
          runtimeActivityObservedAt: 2_000,
          runtimeActivityRevision: 2,
        };
      },
    });
    harness.sessionSocket = socketA;
    harness.userSocket = createApiSessionSocketStub({ connected: true });
    const session = createPlainSessionFixture({
      id: 's-superseded-startup-publisher-claim',
    });
    const client = new ApiSessionClient('tok', session, {
      initialRegisteredSessionStateFieldMutations: [
        createRegisteredSessionStateFieldMutation({
          sessionId: session.id,
          fieldId: 'runtime.activity',
          deliveryClass: 'durable_best_effort',
          source: 'runtime',
          op: {
            kind: 'set',
            value: { state: 'unknown', activeCount: 0 },
          },
        }),
      ],
      durableMutationDeliveryInitiallyActive: false,
    });
    const clientInternals = client as never as {
      socket: ApiSessionSocketStub;
      sessionSyncPendingInputServerContractResult: unknown;
    };
    clientInternals.sessionSyncPendingInputServerContractResult = {
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 1,
      socket: socketA,
    };

    const claim = client.claimCurrentSessionPublisherAuthorityForStartup();
    await expect.poll(() =>
      socketA.emitWithAck.mock.calls.some(
        ([event]) => event === 'runtime-activity-snapshot',
      ),
    ).toBe(true);

    clientInternals.socket = socketB;
    clientInternals.sessionSyncPendingInputServerContractResult = {
      mode: 'session_sync_v2_pending_input_v1',
      sessionConnectionEpoch: 2,
      socket: socketB,
    };
    client.emit('session-sync-server-contract');
    firstAcknowledge.resolve();
    await claim;

    expect(socketA.emitWithAck).toHaveBeenCalledTimes(1);
    expect(socketB.emitWithAck).toHaveBeenCalledWith(
      'runtime-activity-snapshot',
      {
        sid: 's-superseded-startup-publisher-claim',
        state: 'unknown',
        runtimeActivityActiveCount: 0,
      },
    );
  });
});
