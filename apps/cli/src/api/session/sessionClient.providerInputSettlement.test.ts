import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import { PendingQueueAcceptedSettlementError } from './pendingQueueV2Transport';
import { ApiSessionClient } from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const resolveAcceptedMock = vi.hoisted(() => vi.fn());
const blockDeliveryMock = vi.hoisted(() => vi.fn());
const listDeliveryStatusesMock = vi.hoisted(() => vi.fn());

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

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    stop: async () => {},
  }),
}));

vi.mock('./pendingQueueV2Transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pendingQueueV2Transport')>();
  return {
    ...actual,
    resolveAcceptedPendingQueueV2Delivery: resolveAcceptedMock,
    blockPendingQueueV2Delivery: blockDeliveryMock,
    listPendingQueueV2DeliveryStatusesFromServer: listDeliveryStatusesMock,
  };
});

describe('ApiSessionClient provider-input settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
    resolveAcceptedMock.mockReset();
    blockDeliveryMock.mockReset();
    listDeliveryStatusesMock.mockReset();
  });

  it('retires only exact absent terminal custody without emitting a provider settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('manual-handled-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'later-local', status: 'queued' },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);

    expect(client.hasPendingProviderInput('manual-handled-local')).toBe(false);
    expect(resolveAcceptedMock).not.toHaveBeenCalled();
    expect(blockDeliveryMock).not.toHaveBeenCalled();
  });

  it('retires an exact discarded terminal custody claim', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('discarded-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'discarded-local', status: 'discarded' },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(true);

    expect(client.hasPendingProviderInput('discarded-local')).toBe(false);
  });

  it.each(['queued', 'delivering', 'blocked'] as const)(
    'retains exact local custody while the server row remains %s',
    async (status) => {
      sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      const localId = `unresolved-${status}`;
      (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
      listDeliveryStatusesMock.mockResolvedValueOnce([{ localId, status }]);

      await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

      expect(client.hasPendingProviderInput(localId)).toBe(true);
    },
  );

  it('retains exact local custody when status reconciliation fails', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('network-failure-local');
    listDeliveryStatusesMock.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

    expect(client.hasPendingProviderInput('network-failure-local')).toBe(true);
  });

  it('does not retire exact local custody from another localId terminal status', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('exact-live-local');
    listDeliveryStatusesMock.mockResolvedValueOnce([
      { localId: 'wrong-terminal-local', status: 'discarded' },
      { localId: 'exact-live-local', status: 'delivering' },
    ]);

    await expect(client.reconcilePendingProviderInputCustodyBeforeMaterialization()).resolves.toBe(false);

    expect(client.hasPendingProviderInput('exact-live-local')).toBe(true);
  });

  it('routes normalized accepted, pre-effect, and ambiguous outcomes through the canonical Pending actions', async () => {
    resolveAcceptedMock.mockResolvedValue({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    blockDeliveryMock.mockResolvedValue({
      pendingQueueState: { known: true, pendingCount: 2, pendingBlockedCount: 2, pendingVersion: 4 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    for (const localId of ['accepted-local', 'rejected-local', 'uncertain-local']) {
      materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    }

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 1,
    });
    client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId: 'rejected-local',
      userMessageSeq: 2,
      reason: 'provider_rejected_before_acceptance',
      diagnostic: { code: 'provider_rejected', severity: 'error' },
      retryable: false,
    });
    client.observeProviderInputSettlement({
      kind: 'effect_may_have_occurred',
      localId: 'uncertain-local',
      userMessageSeq: 3,
      issue: { code: 'response_lost', severity: 'error' },
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(2));
    expect(resolveAcceptedMock).toHaveBeenCalledWith({
      socket: sessionSocketStub,
      sessionId: 's1',
      localId: 'accepted-local',
    });
    expect(blockDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'rejected-local',
      reason: 'provider_rejected_before_acceptance',
    }));
    expect(blockDeliveryMock).toHaveBeenCalledWith(expect.objectContaining({
      localId: 'uncertain-local',
      reason: 'delivery_outcome_uncertain',
    }));
    expect(client.hasPendingProviderInput('accepted-local')).toBe(false);
    expect(client.hasPendingProviderInput('rejected-local')).toBe(false);
    expect(client.hasPendingProviderInput('uncertain-local')).toBe(true);

  });

  it('publishes the accepted dispatch-time model without changing selected-next intent', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const fixture = createPlainSessionFixture({ id: 's1' });
    const client = new ApiSessionClient('tok', {
      ...fixture,
      metadata: {
        ...fixture.metadata,
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 20,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'gpt-5.6-sol',
          },
        },
      },
    });
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('accepted-local');
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      (client as any).metadata = updater((client as any).metadata);
    });

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 43,
      appliedModel: {
        provider: 'codex',
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5.6-terra',
        },
      },
    });

    await vi.waitFor(() => expect(client.getMetadataSnapshot()?.sessionAppliedModelV1).toMatchObject({
      v: 1,
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      selection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'gpt-5.6-terra',
      },
    }));
    expect(client.getMetadataSnapshot()?.modelSelectionIntentV1?.selection?.modelId).toBe('gpt-5.6-sol');
  });

  it.each([
    'terminal_composer_draft',
    'runtime_config_blocked',
    'provider_unavailable_before_acceptance',
  ] as const)('retains the exact claim through reversible %s blocking for late acceptance', async (reason) => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = `reversible-${reason}`;
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason,
      diagnostic: { code: reason, severity: 'error' },
      retryable: true,
    });

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: 42,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(false);
  });

  it('retries an accepted settlement once at the typed operation-local delay and accepts exact committed replay', async () => {
    vi.useFakeTimers();
    resolveAcceptedMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError(
        'transaction-unavailable',
        1_250,
        'accepted-settlement-1',
      ))
      .mockResolvedValueOnce({
        didResolve: false,
        pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
        message: { localId: 'accepted-local', seq: 43 },
      });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('accepted-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);
    expect(client.hasPendingProviderInput('accepted-local')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_249);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('accepted-local')).toBe(false);
    expect(client.getCommittedUserMessageSeq('accepted-local')).toBe(43);
  });

  it('records the exact committed message returned by a first accepted settlement', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 2 },
      message: { localId: 'accepted-first-local', seq: 44 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('accepted-first-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-first-local',
      userMessageSeq: null,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.hasPendingProviderInput('accepted-first-local')).toBe(false));
    expect(client.getCommittedUserMessageSeq('accepted-first-local')).toBe(44);
  });

  it('rejoins once after socket ACK response loss, then stops after a second failure and ignores later wakes', async () => {
    vi.useFakeTimers();
    const ackResponseLoss = new SocketAckError({
      code: 'socket_ack_timeout',
      event: 'pending-delivery-accepted-v1',
      timeoutMs: 10_000,
    });
    resolveAcceptedMock
      .mockRejectedValueOnce(ackResponseLoss)
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('response-lost-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'response-lost-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('response-lost-local')).toBe(true);

    client.wakePendingMaterialization();
    sessionSocketStub.trigger('session-turn-updated', { status: 'completed' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(2);
    expect(client.hasPendingProviderInput('response-lost-local')).toBe(true);
  });

  it('abandons the accepted settlement retry when the session connection epoch changes', async () => {
    vi.useFakeTimers();
    resolveAcceptedMock
      .mockRejectedValueOnce(new PendingQueueAcceptedSettlementError('transaction-unavailable', 1_250))
      .mockResolvedValueOnce({ didResolve: true });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('epoch-fenced-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'epoch-fenced-local',
      userMessageSeq: 43,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);

    (client as any).sessionConnectionEpoch += 1;
    await vi.advanceTimersByTimeAsync(1_250);

    expect(resolveAcceptedMock).toHaveBeenCalledTimes(1);
    expect(client.hasPendingProviderInput('epoch-fenced-local')).toBe(true);
  });

  it('keeps an unrelated accepted-settlement no-op visible for exact reconciliation', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: false,
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 },
      message: null,
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const materializationRuntime = (client as any).materializationRuntime;
    materializationRuntime.markPendingQueueMaterializedLocalId('unrelated-noop-local');

    client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'unrelated-noop-local',
      userMessageSeq: 43,
    });

    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput('unrelated-noop-local')).toBe(true);
  });
});
