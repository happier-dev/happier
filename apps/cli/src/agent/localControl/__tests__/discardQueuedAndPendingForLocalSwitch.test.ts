import { describe, expect, it, vi } from 'vitest';

import { discardQueuedAndPendingForLocalSwitch } from '../discardQueuedAndPendingForLocalSwitch';

describe('discardQueuedAndPendingForLocalSwitch', () => {
  it('returns proceed without calling discard when queue and server are empty', async () => {
    const discardController = vi.fn();
    const queue = {
      queue: [] as Array<{ message: string; mode?: { localId?: string | null } }>,
      size: () => 0,
      reset: vi.fn(),
    };

    const result = await discardQueuedAndPendingForLocalSwitch({
      queue,
      getServerPendingCount: async () => 0,
      discardServerPending: async () => 0,
      markQueuedAsDiscarded: async () => undefined,
      sendStatusMessage: vi.fn(),
      formatError: (error: unknown) => String(error),
      discardController,
    });

    expect(result).toBe('proceed');
    expect(discardController).not.toHaveBeenCalled();
  });

  it('passes queued preview and local ids through to discard controller', async () => {
    const discardController = vi.fn(async () => 'cancelled' as const);
    const queue = {
      queue: [
        { message: 'msg-1', mode: { localId: 'l1' } },
        { message: 'msg-2', mode: { localId: null } },
        { message: 'msg-3', mode: { localId: 'l2' } },
      ],
      size: () => 3,
      reset: vi.fn(),
    };

    const result = await discardQueuedAndPendingForLocalSwitch({
      queue,
      getServerPendingCount: async () => 2,
      discardServerPending: async () => 0,
      markQueuedAsDiscarded: async () => undefined,
      sendStatusMessage: vi.fn(),
      formatError: (error: unknown) => String(error),
      onCancelled: vi.fn(),
      discardController,
    });

    expect(result).toBe('cancelled');
    expect(discardController).toHaveBeenCalledTimes(1);
    expect(discardController).toHaveBeenCalledWith(
      expect.objectContaining({
        queuedCount: 3,
        queuedLocalIds: ['l1', 'l2'],
        serverPendingCount: 2,
      }),
    );
  });
});
