import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { VoiceActionConfirmationBinding } from '@happier-dev/protocol/voice/actions';
import type { ActionPreparedOperation } from '@happier-dev/protocol/actions/executor/types';

export type SpokenActionConfirmationBinding = VoiceActionConfirmationBinding;

/** Normalized operation and safe summary supplied by the shared Action owner. */
export type SpokenActionOperation = SpokenActionConfirmationBinding & Pick<ActionPreparedOperation,
  'actionId' | 'summary' | 'normalizedInput' | 'sessionTargetsV1'> & Readonly<{
  /** Original model operand, used only to match the later read-back answer. */
  requestInput: unknown;
  serverId?: string | null;
  defaultSessionId?: string | null;
}>;

export type SpokenActionReadBackRequired = Readonly<{
  kind: 'read_back_and_confirm';
  actionId: ActionId;
  summary: string;
  confirmation: SpokenActionConfirmationBinding;
}>;

type PendingSpokenAction = Readonly<{
  operation: SpokenActionOperation;
  readBackComplete: boolean;
}>;

/** One pending operation on a live carrier, without persistence or expiry. */
export function createSpokenActionConfirmation() {
  let pending: PendingSpokenAction | null = null;
  return {
    prepare(operation: SpokenActionOperation): SpokenActionReadBackRequired {
      if (pending?.operation.actionId !== operation.actionId
        || pending.operation.actionRequestId !== operation.actionRequestId
        || pending.operation.inputDigest !== operation.inputDigest) {
        pending = { operation, readBackComplete: false };
      }
      return { kind: 'read_back_and_confirm', actionId: operation.actionId, summary: pending.operation.summary,
        confirmation: { actionRequestId: operation.actionRequestId, inputDigest: operation.inputDigest } };
    },
    readPending(): PendingSpokenAction | null { return pending; },
    // Capture the pending object before awaiting playback. A superseded speech
    // completion must never claim it read a replacement operation aloud.
    completeReadBack(spoken: PendingSpokenAction | null): boolean {
      if (!spoken || spoken !== pending) return false;
      if (!pending.readBackComplete) pending = { ...pending, readBackComplete: true };
      return true;
    },
    consume(input: Readonly<{
      actionId: ActionId;
      inputDigest: string;
      confirmation: SpokenActionConfirmationBinding;
    }>): boolean {
      if (!pending?.readBackComplete || input.actionId !== pending.operation.actionId
        || input.inputDigest !== pending.operation.inputDigest
        || input.confirmation.actionRequestId !== pending.operation.actionRequestId
        || input.confirmation.inputDigest !== pending.operation.inputDigest) return false;
      pending = null;
      return true;
    },
    clear(): void { pending = null; },
  };
}

export type SpokenActionConfirmation = ReturnType<typeof createSpokenActionConfirmation>;
