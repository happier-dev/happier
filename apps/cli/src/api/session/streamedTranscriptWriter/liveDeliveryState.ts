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
  lastCheckpointAtMs: number;
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

export function shouldPublishLiveDelta(
  state: LiveDeliveryState,
  params: Readonly<{
    state: LiveDeliveryIntent['state'];
    nowMs: number;
    epoch: number;
    liveCheckpointIntervalMs: number;
    supportsDelta: boolean;
  }>,
): boolean {
  const accepted = state.locallyAccepted;
  if (!params.supportsDelta || !accepted || state.checkpointRequired) return false;
  if (!state.appendOnlySinceLocallyAccepted || params.state !== 'streaming') return false;
  if (params.liveCheckpointIntervalMs <= 0 || accepted.epoch !== params.epoch) return false;
  return params.nowMs - accepted.lastCheckpointAtMs < params.liveCheckpointIntervalMs;
}

export function acceptLivePublication(
  state: LiveDeliveryState,
  publication: Readonly<{
    text: string;
    tick: number;
    epoch: number;
    acceptedAtMs: number;
    wasCheckpoint: boolean;
  }>,
): boolean {
  if (state.disposed) return false;
  const lastCheckpointAtMs = publication.wasCheckpoint
    ? publication.acceptedAtMs
    : state.locallyAccepted?.lastCheckpointAtMs ?? 0;
  state.locallyAccepted = {
    text: publication.text,
    tick: publication.tick,
    epoch: publication.epoch,
    acceptedAtMs: publication.acceptedAtMs,
    lastCheckpointAtMs,
  };
  state.appendOnlySinceLocallyAccepted = true;
  state.checkpointRequired = false;
  return true;
}

export function disposeLiveDeliveryState(state: LiveDeliveryState): void {
  state.disposed = true;
  state.pending = null;
}
