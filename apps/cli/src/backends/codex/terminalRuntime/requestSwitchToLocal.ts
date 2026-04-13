import { discardQueuedAndPendingForLocalSwitch } from '@/agent/localControl/discardQueuedAndPendingForLocalSwitch';

type QueueItem = {
  message: string;
  mode?: {
    localId?: string | null;
  };
};

type QueueLike = {
  queue: ReadonlyArray<QueueItem>;
  size: () => number;
  reset: () => void;
};

type SessionLike = {
  peekPendingMessageQueueV2Count: () => Promise<number>;
  discardPendingMessageQueueV2All: (opts: { reason: 'switch_to_local' | 'manual' }) => Promise<number>;
  discardCommittedMessageLocalIds: (opts: {
    localIds: string[];
    reason: 'switch_to_local' | 'manual';
  }) => Promise<number>;
  sendSessionEvent: (event: { type: 'message'; message: string }) => void;
};

export async function requestSwitchToLocal<Reason extends string>(params: {
  queue: QueueLike;
  session: SessionLike;
  resolveLocalSwitchAvailability: () => Promise<{ ok: true } | { ok: false; reason: Reason }>;
  requestSwitch: () => Promise<void>;
  formatSwitchDeniedMessage: (reason: Reason) => string;
  formatError: (error: unknown) => string;
}): Promise<boolean> {
  const availability = await params.resolveLocalSwitchAvailability();
  if (!availability.ok) {
    const message = params.formatSwitchDeniedMessage(availability.reason);
    params.session.sendSessionEvent({ type: 'message', message });
    return false;
  }

  const discardResult = await discardQueuedAndPendingForLocalSwitch({
    queue: params.queue,
    getServerPendingCount: () => params.session.peekPendingMessageQueueV2Count(),
    discardServerPending: () => params.session.discardPendingMessageQueueV2All({ reason: 'switch_to_local' }),
    markQueuedAsDiscarded: (localIds) =>
      params.session.discardCommittedMessageLocalIds({ localIds: [...localIds], reason: 'switch_to_local' }),
    sendStatusMessage: (message) => {
      params.session.sendSessionEvent({ type: 'message', message });
    },
    formatError: params.formatError,
  });

  if (discardResult !== 'proceed') {
    return false;
  }

  await params.requestSwitch();
  return true;
}
