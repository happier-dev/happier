import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { buildSession } from '@/sync/engine/pending/pendingQueueV2.testHelpers';
import type { LazyActionAccountContext } from './actionAccountContext';

// The Sync transport is the boundary: retained-input resolution and the Action's cleanup decision stay real.
const transport = vi.hoisted(() => ({
  sendPendingMessageNow: vi.fn(),
  deletePendingMessage: vi.fn(),
  discardPendingMessage: vi.fn(),
  deleteDiscardedPendingMessage: vi.fn(),
}));
vi.mock('@/sync/sync', () => ({ sync: transport }));

const { createUiPendingSendNowAction } = await import('./pendingSendNow');

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;
const sessionId = 'send-now-session';
const accountLifetime = { scope, isCurrent: () => true };
// The Action reads only its captured scope and currentness from the Account context.
const account = {
  serverId: scope.serverId,
  accountLifetime,
  assertCurrent: () => {},
} as unknown as LazyActionAccountContext;
const owner = { serverId: scope.serverId, accountLifetime };

function queued(id: string): PendingMessage {
  return {
    id,
    localId: `local-${id}`,
    createdAt: 1,
    updatedAt: 1,
    source: 'server_pending',
    deliveryStatus: 'accepted',
    text: id,
    rawRecord: { role: 'user', content: { type: 'text', text: id }, meta: {} },
  };
}

async function sendNow(
  localId: string,
  deliveryIntent: 'steer_now' | 'interrupt_and_send' = 'interrupt_and_send',
) {
  return await createUiPendingSendNowAction(account)({
    sessionId,
    localId,
    serverId: scope.serverId,
    deliveryIntent,
    context: { surface: 'ui', authority: 'present_user' },
  } as Parameters<ReturnType<typeof createUiPendingSendNowAction>>[0]);
}

describe('session.pending.sendNow cleanup', () => {
  beforeEach(() => {
    for (const fn of Object.values(transport)) fn.mockReset();
    storage.getState().activateProfileScope(scope);
    storage.getState().applySessions([buildSession({ sessionId })]);
    storage
      .getState()
      .applyPendingSnapshot(sessionId, {
        messages: [queued('p1')],
        discarded: [],
      });
  });

  it('resubmits the retained identity, then retires a provider-direct row only after the commit', async () => {
    transport.sendPendingMessageNow.mockResolvedValueOnce({
      type: 'committed',
      persistence: 'provider_direct',
    });
    transport.deletePendingMessage.mockResolvedValueOnce(undefined);

    await sendNow('local-p1');

    expect(transport.sendPendingMessageNow).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        localId: 'local-p1',
        text: 'p1',
        deliveryIntent: 'interrupt_and_send',
      }),
      owner,
    );
    expect(transport.deletePendingMessage).toHaveBeenCalledWith(
      sessionId,
      'p1',
      owner,
    );
    expect(
      transport.sendPendingMessageNow.mock.invocationCallOrder[0]!,
    ).toBeLessThan(transport.deletePendingMessage.mock.invocationCallOrder[0]!);
  });

  it.each([
    [
      'provider acceptance is pending',
      {
        type: 'committed',
        persistence: 'provider_direct',
        providerAcceptancePending: true,
      },
    ],
    [
      'only the transcript committed',
      { type: 'committed', persistence: 'transcript_committed' },
    ],
    ['the send is queued for retry', { type: 'retry_scheduled' }],
  ])('keeps the row when %s', async (_case, result) => {
    transport.sendPendingMessageNow.mockResolvedValueOnce(result);

    await expect(sendNow('local-p1')).resolves.toEqual(result);

    expect(transport.deletePendingMessage).not.toHaveBeenCalled();
    expect(transport.discardPendingMessage).not.toHaveBeenCalled();
  });

  it('discards the row when deleting it fails after a provider-direct commit', async () => {
    transport.sendPendingMessageNow.mockResolvedValueOnce({
      type: 'committed',
      persistence: 'provider_direct',
    });
    transport.deletePendingMessage.mockRejectedValueOnce(
      new Error('delete failed'),
    );
    transport.discardPendingMessage.mockResolvedValueOnce(undefined);

    await sendNow('local-p1');

    expect(transport.discardPendingMessage).toHaveBeenCalledWith(
      sessionId,
      'p1',
      owner,
    );
  });

  it('does not touch the row when the send itself fails', async () => {
    transport.sendPendingMessageNow.mockRejectedValueOnce(
      new Error('send failed'),
    );

    await expect(sendNow('local-p1')).rejects.toThrow('send failed');

    expect(transport.deletePendingMessage).not.toHaveBeenCalled();
    expect(transport.discardPendingMessage).not.toHaveBeenCalled();
  });

  it('retires a discarded row through the discarded owner after a provider-direct steer', async () => {
    storage
      .getState()
      .applyPendingSnapshot(sessionId, {
        messages: [],
        discarded: [
          { ...queued('d1'), discardedAt: 2, discardedReason: 'manual' },
        ],
      });
    transport.sendPendingMessageNow.mockResolvedValueOnce({
      type: 'committed',
      persistence: 'provider_direct',
    });

    await sendNow('local-d1', 'steer_now');

    expect(transport.sendPendingMessageNow).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        localId: 'local-d1',
        deliveryIntent: 'steer_now',
      }),
      owner,
    );
    expect(transport.deleteDiscardedPendingMessage).toHaveBeenCalledWith(
      sessionId,
      'd1',
      owner,
    );
    expect(transport.deletePendingMessage).not.toHaveBeenCalled();
  });
});
