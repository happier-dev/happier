import { confirmDiscardQueuedMessagesForSwitchToLocal } from '@/agent/localControl/confirmDiscardBeforeSwitchToLocal';
import { discardPendingBeforeSwitchToLocal } from '@/agent/localControl/discardPendingBeforeSwitchToLocal';

type QueueWithLocalIds = {
  queue: ReadonlyArray<{
    message: string;
    mode?: {
      localId?: string | null;
    };
  }>;
  size: () => number;
  reset: () => void;
};

type DiscardController = (args: Parameters<typeof discardPendingBeforeSwitchToLocal>[0]) => Promise<
  Awaited<ReturnType<typeof discardPendingBeforeSwitchToLocal>>
>;

export async function discardQueuedAndPendingForLocalSwitch(opts: {
  queue: QueueWithLocalIds;
  getServerPendingCount: () => Promise<number>;
  discardServerPending: () => Promise<number>;
  markQueuedAsDiscarded: (localIds: readonly string[]) => Promise<unknown>;
  sendStatusMessage: (message: string) => void;
  formatError: (error: unknown) => string;
  onCancelled?: () => void;
  discardController?: DiscardController;
}): Promise<Awaited<ReturnType<typeof discardPendingBeforeSwitchToLocal>>> {
  const queuedCount = opts.queue.size();
  const queuedPreview = opts.queue.queue.map((item) => item.message);
  const queuedLocalIds = opts.queue.queue
    .map((item) => item.mode?.localId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const serverPendingCount = await opts.getServerPendingCount();

  if (queuedCount === 0 && serverPendingCount === 0) {
    return 'proceed';
  }

  const discardController =
    opts.discardController ??
    ((args) =>
      discardPendingBeforeSwitchToLocal({
        ...args,
      }));

  return await discardController({
    queuedCount,
    queuedLocalIds,
    serverPendingCount,
    confirmDiscard: () =>
      confirmDiscardQueuedMessagesForSwitchToLocal({
        queuedCount,
        queuedPreview,
        serverCount: serverPendingCount,
        serverPreview: [],
      }),
    discardServerPending: opts.discardServerPending,
    markQueuedAsDiscarded: opts.markQueuedAsDiscarded,
    resetQueued: () => {
      opts.queue.reset();
    },
    sendStatusMessage: opts.sendStatusMessage,
    formatError: opts.formatError,
    onCancelled: opts.onCancelled,
  });
}
