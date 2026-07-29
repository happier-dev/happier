import { describe, expect, it } from 'vitest';

import {
  acceptLivePublication,
  createLiveDeliveryState,
  disposeLiveDeliveryState,
  markLiveDeliveryFailure,
  queueLiveDeliveryIntent,
  shouldPublishLiveDelta,
  takePendingLiveDeliveryIntent,
} from './liveDeliveryState';

describe('liveDeliveryState', () => {
  it('advances its baseline only after a locally accepted publication', () => {
    const state = createLiveDeliveryState();
    markLiveDeliveryFailure(state);

    expect(state.locallyAccepted).toBeNull();
    expect(state.checkpointRequired).toBe(true);

    acceptLivePublication(state, {
      text: 'hello',
      tick: 1,
      epoch: 3,
      acceptedAtMs: 100,
      wasCheckpoint: true,
    });

    expect(state.locallyAccepted).toMatchObject({ text: 'hello', tick: 1, epoch: 3 });
    expect(state.checkpointRequired).toBe(false);
  });

  it('requires a checkpoint after failure, rewrite, or connection epoch change', () => {
    const state = createLiveDeliveryState();
    acceptLivePublication(state, {
      text: 'hello',
      tick: 1,
      epoch: 3,
      acceptedAtMs: 100,
      wasCheckpoint: true,
    });

    expect(shouldPublishLiveDelta(state, {
      state: 'streaming',
      nowMs: 101,
      epoch: 3,
      liveCheckpointIntervalMs: 1_000,
      supportsDelta: true,
    })).toBe(true);

    markLiveDeliveryFailure(state);
    expect(shouldPublishLiveDelta(state, {
      state: 'streaming',
      nowMs: 102,
      epoch: 3,
      liveCheckpointIntervalMs: 1_000,
      supportsDelta: true,
    })).toBe(false);
    expect(shouldPublishLiveDelta(createLiveDeliveryState(), {
      state: 'streaming',
      nowMs: 102,
      epoch: 4,
      liveCheckpointIntervalMs: 1_000,
      supportsDelta: true,
    })).toBe(false);
  });

  it('coalesces pending work and keeps terminal intent authoritative', () => {
    const state = createLiveDeliveryState();
    queueLiveDeliveryIntent(state, { state: 'streaming' });
    queueLiveDeliveryIntent(state, { state: 'complete' });
    queueLiveDeliveryIntent(state, { state: 'streaming' });

    expect(takePendingLiveDeliveryIntent(state)).toEqual({ state: 'complete' });
  });

  it('does not accept or queue work after disposal', () => {
    const state = createLiveDeliveryState();
    disposeLiveDeliveryState(state);
    queueLiveDeliveryIntent(state, { state: 'streaming' });
    acceptLivePublication(state, {
      text: 'late',
      tick: 1,
      epoch: 1,
      acceptedAtMs: 1,
      wasCheckpoint: true,
    });

    expect(takePendingLiveDeliveryIntent(state)).toBeNull();
    expect(state.locallyAccepted).toBeNull();
  });
});
