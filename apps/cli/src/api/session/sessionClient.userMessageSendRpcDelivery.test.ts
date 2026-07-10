import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, flushApiSessionClientMessageCommitQueue, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { logger } from '@/ui/logger';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

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
    getState: () => ({ phase: 'online' }),
  }),
}));

vi.mock('axios');

import { ApiSessionClient } from './sessionClient';

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function getAxiosPostMock() {
  const { default: mockedAxios } = await import('axios');
  return vi.mocked(mockedAxios.post);
}

async function getAxiosGetMock() {
  const { default: mockedAxios } = await import('axios');
  return vi.mocked(mockedAxios.get);
}

function createPendingDeliveryHttpError(status: number, error: string): Error & {
  response: { status: number; data: { error: string } };
} {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    response: { status: number; data: { error: string } };
  };
  err.name = 'AxiosError';
  err.response = { status, data: { error } };
  return err;
}

describe('ApiSessionClient session.userMessage.send delivery', () => {
  beforeEach(async () => {
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockReset();
    const axiosGet = await getAxiosGetMock();
    axiosGet.mockReset();
    axiosGet.mockRejectedValue(new Error('transcript lookup unavailable'));
  });

  it('requires exact provider acceptance identity before advancing the delivered user-message watermark', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
    updateMetadata.mockClear();

    client.confirmUserMessageDeliveredToProvider({ userMessageSeq: 10 });
    await Promise.resolve();

    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();

    client.confirmUserMessageDeliveredToProvider({ userMessageSeq: 10, userMessageSeqs: [7, 10] });
    await Promise.resolve();

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata.deliveredUserMessageSeqV1).toBe(10);
    expect(client.getDeliveredUserMessageSeq()).toBe(10);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(10);
  });

  it('answers provider-accepted delivery queries by seq and pending local id', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 7 })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['local-accepted-before-echo'] })).toBe(false);

    client.confirmUserMessageDeliveredToProvider({ localIds: ['local-accepted-before-echo'] });

    expect(client.hasUserMessageProviderAcceptance({ localIds: ['local-accepted-before-echo'] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 7 })).toBe(false);

    client.confirmUserMessageDeliveredToProvider({ userMessageSeq: 7, userMessageSeqs: [7] });

    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 7 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [7] })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [7, 8] })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({
      userMessageSeqs: [7, 8],
      localIds: ['local-accepted-before-echo'],
    })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeqs: [8, 9] })).toBe(false);
  });

  it('records local user-message consumption without provider-accepted custody metadata', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as unknown as { metadata: typeof metadata }).metadata = metadata;
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    updateMetadata.mockClear();

    client.confirmUserMessageLocallyConsumed({
      localIds: ['local-clear'],
      userMessageSeq: 64,
      userMessageSeqs: [64],
    });
    await Promise.resolve();

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect((metadata as Record<string, unknown>).locallyConsumedUserMessageSeqsV1).toEqual([64]);
    expect((metadata as Record<string, unknown>).providerAcceptedUserMessageSeqV1).toBeUndefined();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 64 })).toBe(false);
    expect(client.hasUserMessageLocalConsumption({ userMessageSeq: 64 })).toBe(true);
  });

  it('resolves and blocks provider-owned pending rows through canonical delivery actions', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockResolvedValue({ data: { ok: true, pendingCount: 0, pendingVersion: 7 } });
    const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'local-accepted',
      deliveryState: { mode: 'provider', unresolved: true },
    });
    client.confirmUserMessageDeliveredToProvider({ localIds: ['local-accepted'] });

    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/pending/local-accepted/delivery/accepted'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
      );
    });
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['local-accepted'] })).toBe(true);

    axiosPost.mockClear();
    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'local-blocked',
      deliveryState: { mode: 'provider', unresolved: true },
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['local-blocked'],
      reason: 'provider_rejected_before_acceptance',
    })).resolves.toBe(true);
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/local-blocked/delivery/block'),
      { reason: 'provider_rejected_before_acceptance' },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    expect(loggerDebug.mock.calls.some(([message, payload]) =>
      String(message) === '[pendingQueue] provider delivery block succeeded'
      && (payload as any)?.sessionId === 's1'
      && (payload as any)?.localId === 'local-blocked'
      && (payload as any)?.reason === 'provider_rejected_before_acceptance'
    )).toBe(true);

    axiosPost.mockClear();
    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'local-blocked',
      deliveryState: { mode: 'blocked', reason: 'provider_rejected_before_acceptance' },
    });

    await expect(client.retryPendingMessageDelivery({
      localId: 'local-blocked',
    })).resolves.toBe(true);
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/local-blocked/delivery/retry'),
      {},
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    loggerDebug.mockRestore();
  });

  it('does not persist provider watermark before server-owned accepted pending delivery resolves', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockRejectedValueOnce(new Error('accepted delivery route failed'));

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    updateMetadata.mockClear();

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'watermark-held-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });

    client.confirmUserMessageDeliveredToProvider({
      localIds: ['watermark-held-local'],
      userMessageSeq: 43,
      userMessageSeqs: [43],
    });

    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/pending/watermark-held-local/delivery/accepted'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
      );
    });
    await Promise.resolve();

    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();
  });

  it('retires a stale accepted provider-delivery claim when the server reports that the pending row is gone', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockImplementation(async (url) => {
      if (String(url).includes('/v2/sessions/s1/pending/stale-accepted-local/delivery/accepted')) {
        throw createPendingDeliveryHttpError(404, 'not-found');
      }
      return { data: { ok: true, pendingCount: 0, pendingVersion: 1 } };
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'stale-accepted-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });

    client.confirmUserMessageDeliveredToProvider({
      localIds: ['stale-accepted-local'],
      userMessageSeq: 43,
      userMessageSeqs: [43],
    });

    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/pending/stale-accepted-local/delivery/accepted'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
      );
    });

    await vi.waitFor(() => {
      expect(client.hasCanonicalPendingDeliveryLocalId('stale-accepted-local')).toBe(false);
      expect((client as any).acceptedCanonicalPendingDeliveryRetryLocalIds.has('stale-accepted-local')).toBe(false);
    });
  });

  it('retires a stale blocked provider-delivery claim when the server reports that the pending row is gone', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockImplementation(async (url) => {
      if (String(url).includes('/v2/sessions/s1/pending/stale-block-local/delivery/block')) {
        throw createPendingDeliveryHttpError(404, 'not-found');
      }
      return { data: { ok: true, pendingCount: 0, pendingVersion: 1 } };
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'stale-block-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });

    await expect(client.blockPendingMessageDelivery({
      localIds: ['stale-block-local'],
      reason: 'provider_rejected_before_acceptance',
    })).resolves.toBe(false);

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending/stale-block-local/delivery/block'),
      { reason: 'provider_rejected_before_acceptance' },
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    expect(client.hasCanonicalPendingDeliveryLocalId('stale-block-local')).toBe(false);
  });

  it('retries accepted pending delivery resolution from turn-end catch-up without duplicating a server-resolved accepted write', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    const axiosGet = await getAxiosGetMock();
    axiosPost.mockRejectedValueOnce(new Error('accepted delivery route failed'));
    axiosGet.mockImplementation(async (url) => {
      if (String(url).includes('/v2/sessions/s1/pending')) {
        return { data: { pending: [] } } as never;
      }
      throw new Error('profile lookup unavailable');
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;
    axiosGet.mockClear();
    const catchUpSessionMessages = vi.spyOn(client as any, 'catchUpSessionMessages')
      .mockResolvedValue(undefined);

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'accepted-turn-end-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });

    client.confirmUserMessageDeliveredToProvider({
      localIds: ['accepted-turn-end-local'],
      userMessageSeq: 43,
      userMessageSeqs: [43],
    });

    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/pending/accepted-turn-end-local/delivery/accepted'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
      );
    });
    await vi.waitFor(() => {
      expect((client as any).acceptedCanonicalPendingDeliveryRetryLocalIds.has('accepted-turn-end-local')).toBe(true);
    });

    await (client as any).catchUpOwedUserMessagesAfterTurnEnd();

    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    expect(axiosPost).toHaveBeenCalledTimes(1);
    expect(catchUpSessionMessages).toHaveBeenCalledWith({
      afterSeq: 0,
      authorization: 'explicit_cursor',
    });
    expect(client.hasCanonicalPendingDeliveryLocalId('accepted-turn-end-local')).toBe(false);
    expect(client.getDeliveredUserMessageSeq()).toBe(43);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(43);
  });

  it('retires a canonical provider-delivery claim when the server row is externally resolved', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosGet = await getAxiosGetMock();
    axiosGet.mockResolvedValue({ data: { pending: [] } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).sessionConnectionSupervisor = null;
    const catchUpSessionMessages = vi.spyOn(client as any, 'catchUpSessionMessages')
      .mockResolvedValue(undefined);

    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'externally-resolved-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });
    (client as any).recordCommittedUserMessageSeq('externally-resolved-local', 44);

    await (client as any).catchUpOwedUserMessagesAfterTurnEnd();

    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/pending'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
    );
    expect(client.hasCanonicalPendingDeliveryLocalId('externally-resolved-local')).toBe(false);
    expect(client.getDeliveredUserMessageSeq()).toBe(44);
    expect(catchUpSessionMessages).toHaveBeenCalled();
  });

  it('blocks inherited provider-delivery claims when provider-acceptance mode attaches', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockResolvedValueOnce({
      data: {
        ok: true,
        pendingCount: 1,
        pendingBlockedCount: 1,
        pendingVersion: 2,
      },
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    } as never));
    let metadata = client.getMetadataSnapshot()!;
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/pending/delivery/provider-attach'),
        {},
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }),
      );
    });
    await vi.waitFor(() => {
      expect(client.shouldAttemptPendingMaterialization()).toBe(false);
    });
  });

  it('can defer the provider-accepted watermark without claiming pending delivery state', async () => {
    const materializeAck = vi.fn(async (event: string, payload: unknown) => {
      if (event !== 'pending-materialize-next') {
        return { ok: true };
      }
      expect(payload).toEqual({ sid: 's1', pendingVersion: 1 });
      return {
        ok: true,
        didMaterialize: true,
        didWriteMessage: true,
        localId: 'commit-local',
        pendingCount: 0,
        pendingVersion: 2,
        message: {
          id: 'm-commit',
          seq: 1,
          localId: 'commit-local',
          messageRole: 'user',
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'commit-at-materialize prompt' },
              localId: 'commit-local',
            },
          },
          createdAt: 1_000,
          updatedAt: 1_000,
        },
      };
    });
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: materializeAck,
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockImplementation(async (url) => {
      if (String(url).includes('/pending/delivery/provider-attach')) {
        return { data: { ok: true, pendingCount: 1, pendingVersion: 1 } };
      }
      throw new Error(`Unexpected POST ${String(url)}`);
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    } as never));
    let metadata = client.getMetadataSnapshot()!;
    const axiosGet = await getAxiosGetMock();
    axiosGet.mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 's1',
          seq: 0,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: JSON.stringify(metadata),
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          pendingCount: 1,
          pendingBlockedCount: 0,
          pendingVersion: 1,
          dataEncryptionKey: null,
          latestTurnStatus: 'completed',
        },
      },
    });
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance({
      pendingMaterialization: 'commitAtMaterialize',
    });
    await Promise.resolve();
    updateMetadata.mockClear();

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toMatchObject({
      type: 'materialized',
      localId: 'commit-local',
      seq: 1,
    });

    const urls = axiosPost.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/pending/delivery/provider-attach'))).toBe(false);
    expect(materializeAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 's1', pendingVersion: 1 }, sessionSocketStub);
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();

    client.confirmUserMessageDeliveredToProvider({
      localIds: ['commit-local'],
      userMessageSeq: 1,
      userMessageSeqs: [1],
    });
    await Promise.resolve();

    expect(metadata.deliveredUserMessageSeqV1).toBe(1);
    expect(client.getDeliveredUserMessageSeq()).toBe(1);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(1);
  });

  it('retries provider-attach recovery before materializing inherited provider-delivery claims', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost
      .mockRejectedValueOnce(new Error('temporary offline'))
      .mockResolvedValueOnce({
        data: {
          ok: true,
          pendingCount: 1,
          pendingBlockedCount: 1,
          pendingVersion: 2,
        },
      });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      latestTurnStatus: 'completed',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    } as never));
    let metadata = client.getMetadataSnapshot()!;
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await vi.waitFor(() => {
      expect(axiosPost).toHaveBeenCalledTimes(1);
    });

    await expect(client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' })).resolves.toEqual({ type: 'no_pending' });

    const urls = axiosPost.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      expect.stringContaining('/v2/sessions/s1/pending/delivery/provider-attach'),
      expect.stringContaining('/v2/sessions/s1/pending/delivery/provider-attach'),
    ]);
    expect(urls.some((url) => url.includes('/pending/materialize-next'))).toBe(false);
    expect(client.shouldAttemptPendingMaterialization()).toBe(false);
  });

  it('clears accepted-through-seq canonical delivery ids before gating later materialization', async () => {
    const materializeAck = vi.fn(async () => ({
      ok: true,
      didMaterialize: true,
      didWrite: true,
      localId: 'next-provider-local',
      pendingCount: 0,
      pendingBlockedCount: 0,
      pendingVersion: 4,
      message: {
        id: 'm-next-provider-local',
        seq: 82,
        localId: 'next-provider-local',
        messageRole: 'user',
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'next prompt after aggregate accepted claim' },
            localId: 'next-provider-local',
          },
        },
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    }));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAck: materializeAck });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockImplementation(async (url) => {
      const urlString = String(url);
      if (urlString.includes('/pending/delivery/accepted-through-seq')) {
        return {
          data: {
            ok: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 3,
            resolvedLocalIds: ['through-seq-provider-local'],
          },
        };
      }
      throw new Error(`Unexpected POST ${urlString}`);
    });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({
      id: 's1',
      pendingCount: 1,
      pendingBlockedCount: 0,
      pendingVersion: 1,
    } as never));
    let metadata = client.getMetadataSnapshot()!;
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance({
      pendingMaterialization: 'commitAtMaterialize',
    });
    await Promise.resolve();
    (client as any).observeMaterializedPendingDeliveryState({
      localId: 'through-seq-provider-local',
      deliveryState: { mode: 'provider', unresolved: true },
    });
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('through-seq-provider-local');
    expect(client.hasCanonicalPendingDeliveryLocalId('through-seq-provider-local')).toBe(true);
    expect(client.hasPendingQueueMaterializedLocalId('through-seq-provider-local')).toBe(true);

    client.confirmUserMessageDeliveredToProvider({
      userMessageSeq: 81,
      userMessageSeqs: [81],
    });
    await Promise.resolve();
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(81);
    expect(client.getPendingQueueState()).toMatchObject({ known: true, pendingCount: 1, pendingVersion: 1 });
    expect(client.shouldAttemptPendingMaterialization()).toBe(true);

    const materializeResult = await client.materializeNextPendingMessageSafely({ reconcileWhenEmpty: 'force' });
    expect(materializeAck).toHaveBeenCalledWith('pending-materialize-next', { sid: 's1', pendingVersion: 3 }, sessionSocketStub);
    expect(materializeResult).toMatchObject({
      type: 'materialized',
      localId: 'next-provider-local',
      seq: 82,
    });
    expect(client.hasCanonicalPendingDeliveryLocalId('through-seq-provider-local')).toBe(false);
    expect(client.hasPendingQueueMaterializedLocalId('through-seq-provider-local')).toBe(false);

    const urls = axiosPost.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      expect.stringContaining('/v2/sessions/s1/pending/delivery/accepted-through-seq'),
    ]);
  });

  it('does not advance a deferred provider-acceptance watermark from an agent-queue echo', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
    updateMetadata.mockClear();

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'cli' },
      },
    });

    expect(received).toHaveLength(1);

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'cli' },
            },
          },
          localId: 'l1',
          messageRole: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    await Promise.resolve();

    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();

    client.confirmUserMessageDeliveredToProvider({ localIds: ['l1'], userMessageSeq: 1, userMessageSeqs: [1] });
    await Promise.resolve();

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata.deliveredUserMessageSeqV1).toBe(1);
    expect(client.getDeliveredUserMessageSeq()).toBe(1);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(1);
  });

  it('normalizes reserved CLI source metadata from session.userMessage.send before provider queue delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    updateMetadata.mockClear();

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'l1',
        meta: { source: 'cli', sentFrom: 'cli' },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.meta?.source).toBe('ui');
    expect(received[0]?.meta?.sentFrom).toBe('cli');
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();

    client.confirmUserMessageDeliveredToProvider({ localIds: ['l1'], userMessageSeq: 1, userMessageSeqs: [1] });
    await Promise.resolve();

    expect(updateMetadata).toHaveBeenCalledTimes(1);
    expect(metadata.deliveredUserMessageSeqV1).toBe(1);
    expect(client.getDeliveredUserMessageSeq()).toBe(1);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(1);
  });

  it('does not treat a legacy queue-delivery watermark as provider acceptance after opt-in', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const sessionFixture = createPlainSessionFixture({ id: 's1' });
    const client = new ApiSessionClient('tok', {
      ...sessionFixture,
      metadata: {
        ...(sessionFixture.metadata ?? {}),
        deliveredUserMessageSeqV1: 1,
      },
    });
    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);
  });

  it('persists provider acceptance separately from the legacy queue-delivery watermark', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const sessionFixture = createPlainSessionFixture({ id: 's1' });
    const client = new ApiSessionClient('tok', {
      ...sessionFixture,
      metadata: {
        ...(sessionFixture.metadata ?? {}),
        deliveredUserMessageSeqV1: 1,
      },
    });
    let metadata = client.getMetadataSnapshot()!;
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    client.confirmUserMessageDeliveredToProvider({ userMessageSeq: 2, userMessageSeqs: [2] });
    await Promise.resolve();

    expect(metadata.deliveredUserMessageSeqV1).toBe(2);
    expect((metadata as Record<string, unknown>).providerAcceptedUserMessageSeqV1).toBe(2);
    expect(client.getDeliveredUserMessageSeq()).toBe(2);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(2);
  });

  it('persists only provider-accepted seqs when a later queue handoff is still volatile', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm740', seq: 740, localId: 'l740' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const sessionFixture = createPlainSessionFixture({ id: 's1' });
    const client = new ApiSessionClient('tok', {
      ...sessionFixture,
      metadata: {
        ...(sessionFixture.metadata ?? {}),
        deliveredUserMessageSeqV1: 737,
      },
    });
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
      (client as any).metadata = metadata;
    });

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    await Promise.resolve();
    expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
    updateMetadata.mockClear();
    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'handoff seq 740 before provider accepts 739',
      localId: 'l740',
      meta: { source: 'ui', sentFrom: 'cli' },
    });
    sessionSocketStub.trigger('update', {
      id: 'u740',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm740',
          seq: 740,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'handoff seq 740 before provider accepts 739' },
              localId: 'l740',
              meta: { source: 'ui', sentFrom: 'cli' },
            },
          },
          localId: 'l740',
          messageRole: 'user',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(updateMetadata).not.toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBe(737);

    client.confirmUserMessageDeliveredToProvider({ userMessageSeq: 739, userMessageSeqs: [739] });
    await Promise.resolve();

    expect(metadata.deliveredUserMessageSeqV1).toBe(739);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(739);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 739 })).toBe(true);
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 740 })).toBe(false);
  });

  it('cancels an in-flight queue-handoff watermark persist when provider-acceptance custody is enabled', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    let shouldBlockNextUpdateMetadata = true;
    const updateMetadataStarted = createDeferred<void>();
    const releaseUpdateMetadata = createDeferred<void>();
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      if (shouldBlockNextUpdateMetadata) {
        shouldBlockNextUpdateMetadata = false;
        updateMetadataStarted.resolve();
        await releaseUpdateMetadata.promise;
      }
      metadata = updater(metadata);
    });

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'web' },
      },
    });

    expect(received).toHaveLength(1);
    await updateMetadataStarted.promise;

    client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
    releaseUpdateMetadata.resolve();
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(updateMetadata).toHaveBeenCalledTimes(2);
    expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
    expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    expect(client.getDeliveredUserMessageSeq()).toBeNull();
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();

    client.confirmUserMessageDeliveredToProvider({ localIds: ['l1'], userMessageSeq: 1, userMessageSeqs: [1] });
    await Promise.resolve();

    expect(updateMetadata).toHaveBeenCalledTimes(3);
    expect(metadata.deliveredUserMessageSeqV1).toBe(1);
    expect(client.getDeliveredUserMessageSeq()).toBe(1);
    expect(client.getProviderAcceptedUserMessageSeq()).toBe(1);
  });

  it('delivers the prompt to the agent queue after commit and suppresses later transcript echo updates', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.type).toBe('text');
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'ios' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
  });

  it('does not expose queue-handoff delivery as provider acceptance in queue-handoff mode', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'web' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(client.getDeliveredUserMessageSeq()).toBe(1);
    expect(client.getProviderAcceptedUserMessageSeq()).toBeNull();
    expect(client.hasUserMessageProviderAcceptance({ userMessageSeq: 1 })).toBe(false);
    expect(client.hasUserMessageProviderAcceptance({ localIds: ['l1'] })).toBe(false);
  });

  it('suppresses a transcript echo that arrives reentrantly during RPC prompt delivery', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let triggeredEcho = false;
    client.onUserMessage((msg) => {
      received.push(msg);
      if (triggeredEcho) return;
      triggeredEcho = true;
      sessionSocketStub?.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'ios' },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('refreshes echo suppression when the local user-message commit is acknowledged before a delayed transcript echo', async () => {
    vi.useFakeTimers();
    try {
      let resolveMessageAck: (() => void) | null = null;
      const messageAckStarted = createDeferred<void>();
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event) => {
          if (event !== 'message') {
            return { ok: true };
          }
          await new Promise<void>((resolve) => {
            resolveMessageAck = resolve;
            messageAckStarted.resolve();
          });
          return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

      const received: any[] = [];
      client.onUserMessage((msg) => {
        received.push(msg);
      });

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'ios' },
      });

      await messageAckStarted.promise;
      const releaseAck = ((release: (() => void) | null): (() => void) => {
        if (typeof release !== 'function') {
          throw new Error('expected delayed message ack to be pending');
        }
        return release;
      })(resolveMessageAck);

      try {
        await Promise.resolve();
        expect(received).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(8_000);
      } finally {
        releaseAck();
      }
      await enqueuePromise;
      await flushApiSessionClientMessageCommitQueue(client as any);

      expect(received).toHaveLength(1);

      sessionSocketStub.trigger('update', {
        id: 'u1',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'hello' },
                localId: 'l1',
                meta: { source: 'ui', sentFrom: 'ios' },
              },
            },
            localId: 'l1',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits RPC prompts before handing them to the provider queue', async () => {
    const delayedMessageAck: { release?: () => void } = {};
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAck: async (event) => {
        if (event !== 'message') return { ok: true };
        await new Promise<void>((resolve) => {
          delayedMessageAck.release = resolve;
        });
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const received: Array<{ text: string | undefined; localId: string | undefined; committedSeq: number | null }> = [];
    client.onUserMessage((msg) => {
      const localId = typeof msg.localId === 'string' ? msg.localId : undefined;
      received.push({
        text: msg.content.type === 'text' ? msg.content.text : undefined,
        localId,
        committedSeq: localId ? (client as any).getCommittedUserMessageSeq(localId) : null,
      });
      return true;
    });

    const enqueuePromise = (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { source: 'ui', sentFrom: 'web' },
    });

    try {
      await Promise.resolve();
      expect(received).toHaveLength(0);
    } finally {
      delayedMessageAck.release?.();
      await enqueuePromise;
      await flushApiSessionClientMessageCommitQueue(client as any);
    }

    expect(received).toEqual([
      { text: 'hello', localId: 'l1', committedSeq: 1 },
    ]);
  });

  it('advances the delivered watermark when an accepted local queue handoff commit is acknowledged', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 4, localId: 'daemon-initial-prompt:s1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'daemon initial prompt',
      localId: 'daemon-initial-prompt:s1',
      meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(1);
    expect(updateMetadata).toHaveBeenCalled();
    expect(metadata.deliveredUserMessageSeqV1).toBe(4);
  });

  it('commits daemon initial prompts before handing them to the provider queue', async () => {
    vi.useFakeTimers();
    let releaseMessageAck: () => void = () => {};
    try {
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event) => {
          if (event !== 'message') return { ok: true };
          await new Promise<void>((resolve) => {
            releaseMessageAck = resolve;
          });
          return { ok: true, id: 'm1', seq: 4, localId: 'daemon-initial-prompt:s1' };
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      const received: any[] = [];
      client.onUserMessage((msg) => {
        received.push(msg);
        return true;
      });

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'daemon initial prompt',
        localId: 'daemon-initial-prompt:s1',
        meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
      });

      await Promise.resolve();
      expect(received).toHaveLength(0);

      releaseMessageAck();
      await enqueuePromise;
      await flushApiSessionClientMessageCommitQueue(client as any);

      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('daemon initial prompt');
      expect(received[0]?.localId).toBe('daemon-initial-prompt:s1');
    } finally {
      releaseMessageAck();
      vi.useRealTimers();
    }
  });

  it('keeps deferred provider-acceptance catch-up from redelivering an accepted local queue handoff in the same process', async () => {
    vi.useFakeTimers();
    try {
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAckResult: { ok: true, id: 'm1', seq: 4, localId: 'daemon-initial-prompt:s1' },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      let metadata = client.getMetadataSnapshot()!;
      const updateMetadata = vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
        metadata = updater(metadata);
      });
      client.deferDeliveredUserMessageWatermarkToProviderAcceptance();
      await Promise.resolve();
      expect(metadata.userMessageDeliveryWatermarkModeV1).toBe('providerAcceptance');
      updateMetadata.mockClear();

      const received: any[] = [];
      client.onUserMessage((msg) => {
        received.push(msg);
        return true;
      });

      await (client as any).enqueueSessionUserMessage({
        text: 'daemon initial prompt',
        localId: 'daemon-initial-prompt:s1',
        meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
      });
      await flushApiSessionClientMessageCommitQueue(client as any);

      expect(received).toHaveLength(1);
      expect(updateMetadata).not.toHaveBeenCalled();
      expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000);

      sessionSocketStub.trigger('update', {
        id: 'catchup-daemon-initial-prompt',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 4,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'daemon initial prompt' },
                localId: 'daemon-initial-prompt:s1',
                meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
              },
            },
            localId: 'daemon-initial-prompt:s1',
            messageRole: 'user',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
      expect(updateMetadata).not.toHaveBeenCalled();
      expect(metadata.deliveredUserMessageSeqV1).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets daemon initial prompt server echoes deliver while the local commit ack is delayed', async () => {
    vi.useFakeTimers();
    let releaseMessageAck: () => void = () => {};
    try {
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async (event) => {
          if (event !== 'message') return { ok: true };
          await new Promise<void>((resolve) => {
            releaseMessageAck = resolve;
          });
          return { ok: true, id: 'm1', seq: 1, localId: 'daemon-initial-prompt:s1' };
        },
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      client.deferDeliveredUserMessageWatermarkToProviderAcceptance();

      const received: any[] = [];
      client.onUserMessage((msg) => {
        received.push(msg);
        return true;
      });

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'daemon initial prompt',
        localId: 'daemon-initial-prompt:s1',
        meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
      });

      await Promise.resolve();
      expect(received).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);

      sessionSocketStub.trigger('update', {
        id: 'catchup-daemon-initial-prompt',
        createdAt: Date.now(),
        body: {
          t: 'new-message',
          sid: 's1',
          message: {
            id: 'm1',
            seq: 1,
            content: {
              t: 'plain',
              v: {
                role: 'user',
                content: { type: 'text', text: 'daemon initial prompt' },
                localId: 'daemon-initial-prompt:s1',
                meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
              },
            },
            localId: 'daemon-initial-prompt:s1',
            messageRole: 'user',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.localId).toBe('daemon-initial-prompt:s1');

      releaseMessageAck();
      await enqueuePromise;
      await flushApiSessionClientMessageCommitQueue(client as any);

      expect(received).toHaveLength(1);
    } finally {
      releaseMessageAck();
      vi.useRealTimers();
    }
  });

  it('uses the transcript HTTP fallback before daemon initial prompt provider handoff when socket ack times out', async () => {
    vi.useFakeTimers();
    try {
      sessionSocketStub = createApiSessionSocketStub({
        connected: true,
        emitWithAck: async () => await new Promise(() => {}),
      });
      userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
      const axiosPost = await getAxiosPostMock();
      axiosPost.mockResolvedValue({
        status: 200,
        data: {
          message: {
            id: 'm-http',
            seq: 9,
            localId: 'daemon-initial-prompt:s1',
            createdAt: Date.now(),
          },
        },
      } as never);

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      let metadata = client.getMetadataSnapshot()!;
      vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
        metadata = updater(metadata);
      });

      const received: any[] = [];
      client.onUserMessage((msg) => {
        received.push(msg);
        return true;
      });

      const enqueuePromise = (client as any).enqueueSessionUserMessage({
        text: 'daemon initial prompt',
        localId: 'daemon-initial-prompt:s1',
        meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      await enqueuePromise;
      await flushApiSessionClientMessageCommitQueue(client as any);

      expect(axiosPost).toHaveBeenCalledWith(
        expect.stringContaining('/v2/sessions/s1/messages'),
        expect.objectContaining({
          localId: 'daemon-initial-prompt:s1',
          messageRole: 'user',
        }),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Idempotency-Key': 'daemon-initial-prompt:s1',
          }),
        }),
      );
      expect(received).toHaveLength(1);
      expect(received[0]?.content?.text).toBe('daemon initial prompt');
      expect(received[0]?.localId).toBe('daemon-initial-prompt:s1');
      expect(metadata.deliveredUserMessageSeqV1).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the transcript HTTP fallback before daemon initial prompt provider handoff when the session socket is disconnected', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: false,
      emitWithAckResult: { ok: true, id: 'm-socket', seq: 1, localId: 'daemon-initial-prompt:s1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const axiosPost = await getAxiosPostMock();
    axiosPost.mockResolvedValue({
      status: 200,
      data: {
        message: {
          id: 'm-http-disconnected',
          seq: 11,
          localId: 'daemon-initial-prompt:s1',
          createdAt: Date.now(),
        },
      },
    } as never);

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    let metadata = client.getMetadataSnapshot()!;
    vi.spyOn(client, 'updateMetadata').mockImplementation(async (updater) => {
      metadata = updater(metadata);
    });

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
      return true;
    });

    await (client as any).enqueueSessionUserMessage({
      text: 'daemon initial prompt',
      localId: 'daemon-initial-prompt:s1',
      meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/v2/sessions/s1/messages'),
      expect.objectContaining({
        localId: 'daemon-initial-prompt:s1',
        messageRole: 'user',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Idempotency-Key': 'daemon-initial-prompt:s1',
        }),
      }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('daemon initial prompt');
    expect(received[0]?.localId).toBe('daemon-initial-prompt:s1');
    expect(metadata.deliveredUserMessageSeqV1).toBe(11);
  });

  it('lets the server echo deliver when the RPC local queue handoff is declined', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let acceptQueueHandoff = false;
    client.onUserMessage((msg) => {
      if (!acceptQueueHandoff) return false;
      received.push(msg);
      return true;
    });

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'web' },
      },
    });

    expect(received).toHaveLength(0);

    acceptQueueHandoff = true;
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('lets the server echo deliver when commit ack arrives before a declined RPC local queue handoff echo', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let acceptQueueHandoff = false;
    client.onUserMessage((msg) => {
      if (!acceptQueueHandoff) return false;
      received.push(msg);
      return true;
    });

    await client.rpcHandlerManager.handleRequest({
      method: `s1:${SESSION_RPC_METHODS.SESSION_USER_MESSAGE_SEND}`,
      params: {
        text: 'hello',
        localId: 'l1',
        meta: { source: 'ui', sentFrom: 'web' },
      },
    });
    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(received).toHaveLength(0);

    acceptQueueHandoff = true;
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'hello' },
              localId: 'l1',
              meta: { source: 'ui', sentFrom: 'web' },
            },
          },
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
    expect(received[0]?.localId).toBe('l1');
  });

  it('lets daemon initial prompt server echoes deliver when the first local queue handoff is declined', async () => {
    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'daemon-initial-prompt:s1' },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    let acceptQueueHandoff = false;
    client.onUserMessage((msg) => {
      if (!acceptQueueHandoff) return false;
      received.push(msg);
      return true;
    });

    (client as any).enqueueSessionUserMessage({
      text: 'daemon initial prompt',
      localId: 'daemon-initial-prompt:s1',
      meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
    });

    expect(received).toHaveLength(0);

    acceptQueueHandoff = true;
    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: {
            t: 'plain',
            v: {
              role: 'user',
              content: { type: 'text', text: 'daemon initial prompt' },
              localId: 'daemon-initial-prompt:s1',
              meta: { source: 'daemon-initial-prompt', sentFrom: 'cli' },
            },
          },
          localId: 'daemon-initial-prompt:s1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('daemon initial prompt');
    expect(received[0]?.localId).toBe('daemon-initial-prompt:s1');
  });

  it('defaults session.userMessage.send meta source/sentFrom to ui when missing', async () => {
    let lastMessagePayload: any = null;

    sessionSocketStub = createApiSessionSocketStub({
      connected: true,
      emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1' },
      emitWithAck: async (event, payload) => {
        if (event === 'message') {
          lastMessagePayload = payload;
        }
        return { ok: true, id: 'm1', seq: 1, localId: 'l1' };
      },
    });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));

    const received: any[] = [];
    client.onUserMessage((msg) => {
      received.push(msg);
    });

    (client as any).enqueueSessionUserMessage({
      text: 'hello',
      localId: 'l1',
      meta: { permissionMode: 'yolo' },
    });

    await flushApiSessionClientMessageCommitQueue(client as any);

    expect(lastMessagePayload?.sid).toBe('s1');
    expect(lastMessagePayload?.localId).toBe('l1');
    expect(lastMessagePayload?.message?.t).toBe('plain');
    expect(lastMessagePayload?.message?.v?.meta?.source).toBe('ui');
    expect(lastMessagePayload?.message?.v?.meta?.sentFrom).toBe('ui');

    sessionSocketStub.trigger('update', {
      id: 'u1',
      createdAt: Date.now(),
      body: {
        t: 'new-message',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          content: lastMessagePayload.message,
          localId: 'l1',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.content?.text).toBe('hello');
  });
});
