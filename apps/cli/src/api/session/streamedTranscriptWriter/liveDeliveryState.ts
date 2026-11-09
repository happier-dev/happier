import type { EphemeralSendOutcome } from '../client/transcript/ephemeralSendOutcome';

export type LiveDeliveryIntent = Readonly<{
  state: 'streaming' | 'complete' | 'interrupted';
  interruptedReason?: string;
}>;

export type LocallyAcceptedLivePublication = Readonly<{
  text: string;
  tick: number;
  epoch: number;
  acceptedAtMs: number;
}>;

export type LiveDeliveryState = {
  locallyAccepted: LocallyAcceptedLivePublication | null;
  appendOnlySinceLocallyAccepted: boolean;
  checkpointRequired: boolean;
  inFlight: Promise<void> | null;
  pending: LiveDeliveryIntent | null;
  firstFailure: Extract<EphemeralSendOutcome, { accepted: false }> | null;
  failureCount: number;
  disposed: boolean;
};

export function createLiveDeliveryState(): LiveDeliveryState {
  return {
    locallyAccepted: null,
    appendOnlySinceLocallyAccepted: true,
    checkpointRequired: false,
    inFlight: null,
    pending: null,
    firstFailure: null,
    failureCount: 0,
    disposed: false,
  };
}

export function queueLiveDeliveryIntent(state: LiveDeliveryState, intent: LiveDeliveryIntent): void {
  if (state.disposed) return;
  if (state.pending && state.pending.state !== 'streaming' && intent.state === 'streaming') return;
  state.pending = intent;
}

export function takePendingLiveDeliveryIntent(state: LiveDeliveryState): LiveDeliveryIntent | null {
  if (state.disposed) return null;
  const pending = state.pending;
  state.pending = null;
  return pending;
}

export function hasDirtyLiveDeliveryText(state: LiveDeliveryState, text: string): boolean {
  const accepted = state.locallyAccepted;
  if (!accepted) return text.length > 0;
  if (state.appendOnlySinceLocallyAccepted) return accepted.text.length !== text.length;
  return accepted.text !== text;
}

export function markLiveDeliveryRewrite(state: LiveDeliveryState): void {
  if (state.disposed) return;
  state.appendOnlySinceLocallyAccepted = false;
  state.checkpointRequired = true;
}

export function markLiveDeliveryFailure(
  state: LiveDeliveryState,
  outcome?: Extract<EphemeralSendOutcome, { accepted: false }>,
): boolean {
  if (state.disposed) return false;
  state.checkpointRequired = true;
  state.failureCount += 1;
  if (outcome && !state.firstFailure) state.firstFailure = outcome;
  return state.failureCount === 1;
}

export function takeLiveDeliveryFailureSummary(
  state: LiveDeliveryState,
): Readonly<{ firstFailure: Extract<EphemeralSendOutcome, { accepted: false }> | null; count: number }> | null {
  if (state.failureCount === 0) return null;
  const summary = { firstFailure: state.firstFailure, count: state.failureCount };
  state.firstFailure = null;
  state.failureCount = 0;
  return summary;
}

/**
 * A live emission is a delta whenever the receiver can chain it onto the last accepted text: the
 * segment has an accepted baseline on this connection epoch and has only grown since. Terminal
 * emissions are deltas too; their meta carries the terminal state.
 */
export function shouldPublishLiveDelta(
  state: LiveDeliveryState,
  params: Readonly<{
    epoch: number;
    liveDeltas: boolean;
    supportsDelta: boolean;
  }>,
): boolean {
  const accepted = state.locallyAccepted;
  if (!params.liveDeltas || !params.supportsDelta || !accepted || state.checkpointRequired) return false;
  return state.appendOnlySinceLocallyAccepted && accepted.epoch === params.epoch;
}

export function acceptLivePublication(
  state: LiveDeliveryState,
  publication: Readonly<{
    text: string;
    tick: number;
    epoch: number;
    acceptedAtMs: number;
  }>,
): boolean {
  if (state.disposed) return false;
  state.locallyAccepted = {
    text: publication.text,
    tick: publication.tick,
    epoch: publication.epoch,
    acceptedAtMs: publication.acceptedAtMs,
  };
  state.appendOnlySinceLocallyAccepted = true;
  state.checkpointRequired = false;
  return true;
}

export function disposeLiveDeliveryState(state: LiveDeliveryState): void {
  state.disposed = true;
  state.pending = null;
}
