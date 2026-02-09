export type DiscardPendingBeforeSwitchToLocalResult = 'proceed' | 'cancelled' | 'failed';

export async function discardPendingBeforeSwitchToLocal(opts: {
  queuedCount: number;
  queuedLocalIds: readonly string[];
  serverPendingCount: number;
  confirmDiscard: () => Promise<boolean>;
  discardServerPending: () => Promise<number>;
  markQueuedAsDiscarded: (localIds: readonly string[]) => Promise<unknown>;
  resetQueued: () => void;
  sendStatusMessage: (message: string) => void;
  formatError: (error: unknown) => string;
  onCancelled?: () => void;
}): Promise<DiscardPendingBeforeSwitchToLocalResult> {
  if (opts.queuedCount === 0 && opts.serverPendingCount === 0) {
    return 'proceed';
  }

  const confirmed = await opts.confirmDiscard();
  if (!confirmed) {
    opts.onCancelled?.();
    return 'cancelled';
  }

  let discardedServerCount = 0;
  try {
    if (opts.serverPendingCount > 0) {
      discardedServerCount = await opts.discardServerPending();
    }
  } catch (error) {
    opts.sendStatusMessage(
      `Failed to discard pending messages before switching to local mode: ${opts.formatError(error)}`,
    );
    return 'failed';
  }

  try {
    if (opts.queuedLocalIds.length > 0) {
      await opts.markQueuedAsDiscarded(opts.queuedLocalIds);
    }
  } catch (error) {
    opts.sendStatusMessage(
      `Failed to mark queued messages as discarded before switching to local mode: ${opts.formatError(error)}`,
    );
    return 'failed';
  }

  if (opts.queuedCount > 0) {
    opts.resetQueued();
  }

  const parts: string[] = [];
  if (discardedServerCount > 0) {
    parts.push(`${discardedServerCount} pending UI message${discardedServerCount === 1 ? '' : 's'}`);
  }
  if (opts.queuedCount > 0) {
    parts.push(`${opts.queuedCount} queued remote message${opts.queuedCount === 1 ? '' : 's'}`);
  }
  if (parts.length > 0) {
    opts.sendStatusMessage(
      `Discarded ${parts.join(' and ')} to switch to local mode. Please resend them from this terminal if needed.`,
    );
  }

  return 'proceed';
}
