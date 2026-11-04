import type { ActionPreparedOperation } from '@happier-dev/protocol/actions/executor/types';

/** Normalized operation and safe summary supplied by the shared Action owner. */
export type SpokenActionOperation = Pick<ActionPreparedOperation,
  'actionId' | 'summary' | 'normalizedInput' | 'sessionTargetsV1'> & Readonly<{
  actionRequestId: string;
  serverId?: string | null;
  defaultSessionId?: string | null;
}>;

type PendingSpokenAction = Readonly<{
  operation: SpokenActionOperation;
}>;

/** One pending operation on a live carrier, without persistence or expiry. */
export function createSpokenActionConfirmation() {
  let pending: PendingSpokenAction | null = null;
  return {
    prepare(operation: SpokenActionOperation): void {
      pending = { operation };
    },
    readPending(): PendingSpokenAction | null { return pending; },
    // Capture the pending object before awaiting playback. A superseded speech
    // completion must never claim it read a replacement operation aloud.
    completeReadBack(spoken: PendingSpokenAction | null): boolean {
      if (!spoken || spoken !== pending) return false;
      pending = null;
      return true;
    },
    clear(): void { pending = null; },
  };
}

export type SpokenActionConfirmation = ReturnType<typeof createSpokenActionConfirmation>;
