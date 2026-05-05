import { confirmDiscardQueuedMessagesForSwitchToTerminal } from './confirmDiscardBeforeSwitch';
import { discardPendingBeforeSwitchToTerminal } from './discardPendingBeforeSwitch';

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

type DiscardController = (args: Parameters<typeof discardPendingBeforeSwitchToTerminal>[0]) => Promise<
  Awaited<ReturnType<typeof discardPendingBeforeSwitchToTerminal>>
>;

export async function discardQueuedAndPendingForTerminalSwitch(opts: {
  queue: QueueWithLocalIds;
  getServerPendingCount: () => Promise<number>;
  discardServerPending: () => Promise<number>;
  markQueuedAsDiscarded: (localIds: readonly string[]) => Promise<unknown>;
  sendStatusMessage: (message: string) => void;
  formatError: (error: unknown) => string;
  onCancelled?: () => void;
  discardController?: DiscardController;
}): Promise<Awaited<ReturnType<typeof discardPendingBeforeSwitchToTerminal>>> {
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
      discardPendingBeforeSwitchToTerminal({
        ...args,
      }));

  return await discardController({
    queuedCount,
    queuedLocalIds,
    serverPendingCount,
    confirmDiscard: () =>
      confirmDiscardQueuedMessagesForSwitchToTerminal({
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
