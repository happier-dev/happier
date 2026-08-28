import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
} from '@/testkit/backends/apiSessionSocketHarness';
import { SocketAckError } from '@/session/transport/shared/socketAck';
import { PendingQueueAcceptedSettlementError } from './pendingQueueV2Transport';
import {
  ApiSessionClient,
  type ApiSessionClientOptions,
} from './sessionClient';

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;
const resolveAcceptedMock = vi.hoisted(() => vi.fn());
const blockDeliveryMock = vi.hoisted(() => vi.fn());
const listDeliveryStatusesMock = vi.hoisted(() => vi.fn());
const sendSessionMessageMock = vi.hoisted(() => vi.fn());

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage: sendSessionMessageMock,
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
    sendSessionMessageMock.mockReset();
  });

  it('branches on the exact protected admission result instead of a generic send code', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    sendSessionMessageMock.mockResolvedValueOnce({
      ok: false,
      code: 'timeout',
      admissionResult: {
        status: 'outcomeUnknown',
        localId: 'runtime-first-input',
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const credentials = { token: 'tok', encryption: null };
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      { credentials },
    );

    await expect(client.enqueueSessionUserMessage({
      text: 'Hello',
      localId: 'runtime-first-input',
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
  });

  it('notifies prepared Composer attachments after durable admission and on an exact already-accepted retry, never from terminal settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-local-1';
    const firstAttachment = {
      v: 1 as const,
      instanceId: 'review-instance-1',
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      key: 'review-42',
      value: { reviewId: '42' },
      presentation: { label: 'Review #42', typeLabel: 'Review comment' },
    };
    const secondAttachment = {
      ...firstAttachment,
      instanceId: 'review-instance-2',
      key: 'review-43',
      value: { reviewId: '43' },
    };
    const afterComposerAttachmentMessageAccepted = vi.fn<NonNullable<
      ApiSessionClientOptions['afterComposerAttachmentMessageAccepted']
    >>(async () => {
      throw new Error('post-admission target unavailable');
    });
    const machineAdmissionTransport = vi.fn(async () => ({
      status: 'accepted' as const,
      localId,
    }));
    const admissionOrder: string[] = [];
    sendSessionMessageMock
      .mockImplementationOnce(async () => {
        admissionOrder.push('durable:accepted');
        return {
          admissionResult: { status: 'accepted', localId, code: 'accepted' },
        };
      })
      .mockImplementationOnce(async () => {
        admissionOrder.push('durable:alreadyAccepted');
        return {
          admissionResult: { status: 'alreadyAccepted', localId, code: 'already_accepted' },
        };
      });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          ...payload,
          preparedComposerAttachments: (payload.meta as {
            happierStructuredInputV1: { composerAttachments: unknown[] };
          }).happierStructuredInputV1.composerAttachments,
        }),
        afterComposerAttachmentMessageAccepted: async (input) => {
          admissionOrder.push('after');
          await afterComposerAttachmentMessageAccepted(input);
        },
        // RED seam: the runner must supply its authenticated daemon-backed
        // machine admission transport to the Session client.
        machineAdmissionTransport,
      },
    );
    const request = {
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1 as const,
          composerAttachments: [firstAttachment, secondAttachment],
        },
      },
    };

    await expect(client.enqueueSessionUserMessage(request)).resolves.toBeUndefined();

    expect(sendSessionMessageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      machineAdmissionTransport,
      signal: expect.any(AbortSignal),
    }));
    expect(admissionOrder).toEqual(['durable:accepted', 'after']);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledWith({
      attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
      event: {
        sessionId: 's1',
        localId,
        attachments: [
          { instanceId: 'review-instance-1', key: 'review-42', value: { reviewId: '42' } },
          { instanceId: 'review-instance-2', key: 'review-43', value: { reviewId: '43' } },
        ],
      },
      signal: expect.any(AbortSignal),
    });
    expect(afterComposerAttachmentMessageAccepted.mock.calls[0]?.[0]?.event)
      .not.toHaveProperty('messageId');
    const firstNotification = afterComposerAttachmentMessageAccepted.mock.calls[0]?.[0];
    expect(firstNotification?.signal.aborted).toBe(false);

    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId,
      userMessageSeq: 5,
    })).resolves.toBe(false);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();

    await expect(client.enqueueSessionUserMessage(request)).resolves.toBeUndefined();
    expect(sendSessionMessageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      machineAdmissionTransport,
      signal: expect.any(AbortSignal),
    }));
    expect(admissionOrder).toEqual([
      'durable:accepted',
      'after',
      'durable:alreadyAccepted',
      'after',
    ]);
    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledTimes(2);

    await client.close();
    expect(firstNotification?.signal.aborted).toBe(true);
  });

  it('starts the acceptance notification without waiting for staged-media settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-before-settlement';
    const attachment = {
      v: 1 as const,
      instanceId: 'media-instance-1',
      attachment: { pluginId: 'com.example.media', localId: 'composer' },
      key: 'media-1',
      value: { media: 'review' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const order: string[] = [];
    let releaseSettlement: (() => void) | undefined;
    const settlementReached = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    // Staged-media settlement is a daemon round trip whose default budget is
    // 300s. The best-effort acceptance notification contractually FOLLOWS
    // durable acceptance, not settlement, so it must not be serialized behind it.
    const onAccepted = vi.fn(async () => {
      order.push('settlement:start');
      await settlementReached;
      order.push('settlement:end');
    });
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => {
      order.push('notify');
      releaseSettlement?.();
    });
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'accepted', localId, code: 'accepted' },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure: vi.fn(async () => undefined) },
        }),
        afterComposerAttachmentMessageAccepted,
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: { v: 1, composerAttachments: [attachment] },
      },
    })).resolves.toBeUndefined();

    expect(afterComposerAttachmentMessageAccepted).toHaveBeenCalledOnce();
    expect(order).toEqual(['notify', 'settlement:start', 'settlement:end']);
    await client.close();
  });

  it('returns accepted without waiting for staged-media release settlement', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-accepted-independent-of-settlement';
    let releaseSettlement: (() => void) | undefined;
    const settlementBlocked = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const onAccepted = vi.fn(async () => await settlementBlocked);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'accepted', localId, code: 'accepted' },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: payload,
          settlement: {
            onAccepted,
            onDefinitiveAdmissionFailure: vi.fn(async () => undefined),
          },
        }),
      },
    );

    const enqueue = client.enqueueSessionUserMessage({
      text: 'Message with staged media',
      localId,
    });
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    await expect(Promise.race([
      enqueue.then(() => 'accepted' as const),
      new Promise<'timedOut'>((resolve) => setTimeout(() => resolve('timedOut'), 100)),
    ])).resolves.toBe('accepted');

    releaseSettlement?.();
    await client.close();
  });

  it('does not notify a Composer attachment target when durable admission is unknown', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'composer-unknown-admission-local-1';
    const afterComposerAttachmentMessageAccepted = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: {
        status: 'outcomeUnknown',
        localId,
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          ...payload,
          preparedComposerAttachments: (payload.meta as {
            happierStructuredInputV1: { composerAttachments: unknown[] };
          }).happierStructuredInputV1.composerAttachments,
        }),
        afterComposerAttachmentMessageAccepted,
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'review-instance-1',
            attachment: { pluginId: 'acme.review-comments', localId: 'review-comment' },
            key: 'review-42',
            value: { reviewId: '42' },
            presentation: { label: 'Review #42', typeLabel: 'Review comment' },
          }],
        },
      },
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
    expect(afterComposerAttachmentMessageAccepted).not.toHaveBeenCalled();

    await client.close();
  });

  it.each([
    { status: 'accepted' as const, code: 'accepted' as const },
    { status: 'alreadyAccepted' as const, code: 'already_accepted' as const },
  ])('settles staged-media custody only for known Composer $status admission', async ({ status, code }) => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const attachment = {
      v: 1 as const,
      instanceId: 'media-instance-1',
      attachment: { pluginId: 'com.example.media', localId: 'composer' },
      key: 'media-1',
      value: { media: 'review' },
      presentation: { label: 'Review image', typeLabel: 'Review media' },
    };
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    const localId = 'staged-media-local-1';
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status, localId, code },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [attachment],
        },
      },
    })).resolves.toBeUndefined();

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onDefinitiveAdmissionFailure).not.toHaveBeenCalled();
    await client.close();
  });

  it('keeps staged-media settlement inert when Composer admission is outcome-unknown', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'staged-media-unknown-local-1';
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: {
        status: 'outcomeUnknown',
        localId,
        code: 'machine_admission_acknowledgement_failed',
      },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'media-instance-1',
            attachment: { pluginId: 'com.example.media', localId: 'composer' },
            key: 'media-1',
            value: { media: 'review' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
          }],
        },
      },
    })).rejects.toThrow(
      'Session user input admission outcomeUnknown: machine_admission_acknowledgement_failed',
    );
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).not.toHaveBeenCalled();
    await client.close();
  });

  it('settles staged-media custody for an explicit rejected Composer admission only', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const localId = 'staged-media-rejected-local-1';
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    sendSessionMessageMock.mockResolvedValueOnce({
      admissionResult: { status: 'rejected', code: 'session_input_cancelled' },
    });
    const client = new ApiSessionClient(
      'tok',
      createPlainSessionFixture({ id: 's1' }),
      {
        credentials: { token: 'tok', encryption: null },
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: {
            ...payload,
            preparedComposerAttachments: (payload.meta as {
              happierStructuredInputV1: { composerAttachments: unknown[] };
            }).happierStructuredInputV1.composerAttachments,
          },
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: '',
      localId,
      meta: {
        happierStructuredInputV1: {
          v: 1,
          composerAttachments: [{
            v: 1,
            instanceId: 'media-instance-1',
            attachment: { pluginId: 'com.example.media', localId: 'composer' },
            key: 'media-1',
            value: { media: 'review' },
            presentation: { label: 'Review image', typeLabel: 'Review media' },
          }],
        },
      },
    })).rejects.toThrow('Session user input admission rejected: session_input_cancelled');

    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).toHaveBeenCalledOnce();
    await client.close();
  });

  it('settles staged-media custody when missing owner credentials make admission definitively impossible', async () => {
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const onAccepted = vi.fn(async () => undefined);
    const onDefinitiveAdmissionFailure = vi.fn(async () => undefined);
    const client = new ApiSessionClient(
      'missing-credentials-token-never-stored',
      createPlainSessionFixture({ id: 's1' }),
      {
        transformSessionInputBeforeCommit: async (payload) => ({
          transformed: payload,
          settlement: { onAccepted, onDefinitiveAdmissionFailure },
        }),
      },
    );

    await expect(client.enqueueSessionUserMessage({
      text: 'Message with staged media',
      localId: 'staged-media-missing-credentials',
    })).rejects.toThrow('Current Account credentials are required to admit Session user input');

    expect(sendSessionMessageMock).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onDefinitiveAdmissionFailure).toHaveBeenCalledOnce();
    await client.close();
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

  it('releases local custody only when the current server requeues a conditional steer', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 5 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'conditional-steer-requeued-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    (client as any).materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'conditional_steer_unavailable',
      diagnostic: { code: 'steering_unavailable', severity: 'warning' },
      retryable: true,
    })).resolves.toBe(false);

    expect(blockDeliveryMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      localId,
      reason: 'conditional_steer_unavailable',
    }));
    expect(client.hasPendingProviderInput(localId)).toBe(false);
    expect((client as any).materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId)).toBe(false);
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('does not reopen delivery when an older server degrades a conditional steer to a strict block', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 5 },
      usedLegacySteeringUnavailableFallback: true,
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'conditional-steer-legacy-blocked-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    (client as any).materializationRuntime.markAgentQueueEchoSuppressedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 43,
      reason: 'conditional_steer_unavailable',
      diagnostic: { code: 'steering_unavailable', severity: 'warning' },
      retryable: true,
    })).resolves.toBe(false);

    expect(client.hasPendingProviderInput(localId)).toBe(false);
    expect((client as any).materializationRuntime.hasAgentQueueEchoSuppressedLocalId(localId)).toBe(true);
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

  it('retires local custody only after the exact pre-provider rejection is durably blocked', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'admission-unavailable-blocked-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'daemon_turn_admission_unavailable', severity: 'error' },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    })).resolves.toBe(true);

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.hasPendingProviderInput(localId)).toBe(false));

    // A later materialization of the same exact local id is no longer suppressed by stale
    // pre-provider custody once the terminal block has been acknowledged.
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('retains exact local custody when the pre-provider durable block fails', async () => {
    blockDeliveryMock.mockRejectedValueOnce(new Error('block unavailable'));
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'admission-unavailable-block-failed-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    await expect(client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'daemon_turn_admission_unavailable', severity: 'error' },
      retryable: true,
      retireLocalCustodyAfterDurableBlock: true,
    })).resolves.toBe(false);

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);
  });

  it('retains generic provider-unavailable custody without exact pre-provider proof', async () => {
    blockDeliveryMock.mockResolvedValueOnce({
      pendingQueueState: { known: true, pendingCount: 1, pendingBlockedCount: 1, pendingVersion: 2 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const localId = 'generic-provider-unavailable-local';
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId(localId);

    client.observeProviderInputSettlement({
      kind: 'rejected_before_effect',
      localId,
      userMessageSeq: 42,
      reason: 'provider_unavailable_before_acceptance',
      diagnostic: { code: 'provider_unavailable_before_acceptance', severity: 'error' },
      retryable: true,
    });

    await vi.waitFor(() => expect(blockDeliveryMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput(localId)).toBe(true);
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

  it('re-drives exact provider acceptance after reconnect when acceptance arrived while disconnected', async () => {
    resolveAcceptedMock.mockResolvedValueOnce({
      didResolve: true,
      pendingQueueState: { known: true, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 3 },
      message: { localId: 'accepted-while-disconnected', seq: 45 },
    });
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    (client as any).materializationRuntime.markPendingQueueMaterializedLocalId('accepted-while-disconnected');

    sessionSocketStub.connected = false;
    await expect(client.observeProviderInputSettlement({
      kind: 'accepted',
      localId: 'accepted-while-disconnected',
      userMessageSeq: null,
    })).resolves.toBe(false);

    expect(resolveAcceptedMock).not.toHaveBeenCalled();
    expect(client.hasPendingProviderInput('accepted-while-disconnected')).toBe(true);
    expect((client as any).acceptedPendingSettlementLocalIds.has('accepted-while-disconnected')).toBe(true);

    sessionSocketStub.connected = true;
    (client as any).sessionConnectionEpoch += 1;
    (client as any).reofferAcceptedProviderInputSettlementsAfterConnection();
    await vi.waitFor(() => expect(resolveAcceptedMock).toHaveBeenCalledTimes(1));
    expect(client.hasPendingProviderInput('accepted-while-disconnected')).toBe(false);
    expect(client.getCommittedUserMessageSeq('accepted-while-disconnected')).toBe(45);
  });
});
