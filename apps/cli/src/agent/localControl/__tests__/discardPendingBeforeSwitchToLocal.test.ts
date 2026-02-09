import { describe, expect, it, vi } from 'vitest';

import { discardPendingBeforeSwitchToLocal } from '../discardPendingBeforeSwitchToLocal';

describe('discardPendingBeforeSwitchToLocal', () => {
  it('returns proceed without prompting when there is nothing to discard', async () => {
    const confirmDiscard = vi.fn(async () => true);

    const result = await discardPendingBeforeSwitchToLocal({
      queuedCount: 0,
      queuedLocalIds: [],
      serverPendingCount: 0,
      confirmDiscard,
      discardServerPending: async () => 0,
      markQueuedAsDiscarded: async () => {},
      resetQueued: () => {},
      sendStatusMessage: () => {},
      formatError: (error) => String(error),
    });

    expect(result).toBe('proceed');
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('returns cancelled when user declines confirmation', async () => {
    const onCancelled = vi.fn();
    const discardServerPending = vi.fn(async () => 0);
    const markQueuedAsDiscarded = vi.fn(async () => {});

    const result = await discardPendingBeforeSwitchToLocal({
      queuedCount: 1,
      queuedLocalIds: ['l1'],
      serverPendingCount: 2,
      confirmDiscard: async () => false,
      discardServerPending,
      markQueuedAsDiscarded,
      resetQueued: () => {},
      sendStatusMessage: () => {},
      formatError: (error) => String(error),
      onCancelled,
    });

    expect(result).toBe('cancelled');
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(discardServerPending).not.toHaveBeenCalled();
    expect(markQueuedAsDiscarded).not.toHaveBeenCalled();
  });

  it('returns failed and sends an error when discarding server pending messages fails', async () => {
    const sendStatusMessage = vi.fn();

    const result = await discardPendingBeforeSwitchToLocal({
      queuedCount: 1,
      queuedLocalIds: ['l1'],
      serverPendingCount: 1,
      confirmDiscard: async () => true,
      discardServerPending: async () => {
        throw new Error('server boom');
      },
      markQueuedAsDiscarded: async () => {},
      resetQueued: () => {},
      sendStatusMessage,
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(result).toBe('failed');
    expect(sendStatusMessage).toHaveBeenCalledWith(
      'Failed to discard pending messages before switching to local mode: server boom',
    );
  });

  it('returns failed and sends an error when marking queued messages fails', async () => {
    const sendStatusMessage = vi.fn();

    const result = await discardPendingBeforeSwitchToLocal({
      queuedCount: 1,
      queuedLocalIds: ['l1'],
      serverPendingCount: 0,
      confirmDiscard: async () => true,
      discardServerPending: async () => 0,
      markQueuedAsDiscarded: async () => {
        throw new Error('queue boom');
      },
      resetQueued: () => {},
      sendStatusMessage,
      formatError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    expect(result).toBe('failed');
    expect(sendStatusMessage).toHaveBeenCalledWith(
      'Failed to mark queued messages as discarded before switching to local mode: queue boom',
    );
  });

  it('discards server and queued messages and emits a summary on success', async () => {
    const discardServerPending = vi.fn(async () => 2);
    const markQueuedAsDiscarded = vi.fn(async () => {});
    const resetQueued = vi.fn();
    const sendStatusMessage = vi.fn();

    const result = await discardPendingBeforeSwitchToLocal({
      queuedCount: 3,
      queuedLocalIds: ['l1', 'l2'],
      serverPendingCount: 7,
      confirmDiscard: async () => true,
      discardServerPending,
      markQueuedAsDiscarded,
      resetQueued,
      sendStatusMessage,
      formatError: (error) => String(error),
    });

    expect(result).toBe('proceed');
    expect(discardServerPending).toHaveBeenCalledTimes(1);
    expect(markQueuedAsDiscarded).toHaveBeenCalledWith(['l1', 'l2']);
    expect(resetQueued).toHaveBeenCalledTimes(1);
    expect(sendStatusMessage).toHaveBeenCalledWith(
      'Discarded 2 pending UI messages and 3 queued remote messages to switch to local mode. Please resend them from this terminal if needed.',
    );
  });
});
