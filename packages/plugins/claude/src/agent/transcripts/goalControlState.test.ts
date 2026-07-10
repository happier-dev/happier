import { describe, expect, it } from 'vitest';

import { createClaudeGoalControlEpochTracker } from './goalControlState.js';

type ReplayEvent = Readonly<{ met: boolean; uuid: string; sourceRevision: string; condition: string }>;

function activeEvent(uuid: string, condition: string): ReplayEvent {
  return { met: false, uuid, sourceRevision: uuid, condition };
}

function terminalEvent(uuid: string, condition: string): ReplayEvent {
  return { met: true, uuid, sourceRevision: uuid, condition };
}

describe('createClaudeGoalControlEpochTracker', () => {
  it('accepts active events when no clear intent is in effect', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    expect(tracker.resolveReplay(activeEvent('g-1', 'ship it'))).toBe('accept');
  });

  it('suppresses a same-objective active re-evaluation replay after a clear intent', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    tracker.recordIntent({ kind: 'clear', baselineUuid: 'g-1', baselineSourceRevision: 'g-1', baselineCondition: 'ship it' });
    // The provider keeps re-evaluating the un-meetable cleared goal with FRESH uuids.
    expect(tracker.resolveReplay(activeEvent('g-2', 'ship it'))).toBe('suppress');
    expect(tracker.resolveReplay(activeEvent('g-3', 'ship it'))).toBe('suppress');
  });

  it('lifts suppression and accepts a genuinely different active goal after a clear (different objective)', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    tracker.recordIntent({ kind: 'clear', baselineUuid: 'g-1', baselineSourceRevision: 'g-1', baselineCondition: 'ship it' });
    expect(tracker.resolveReplay(activeEvent('g-2', 'a brand new goal'))).toBe('accept');
    // Suppression is lifted: the original objective is no longer suppressed either.
    expect(tracker.resolveReplay(activeEvent('g-3', 'ship it'))).toBe('accept');
  });

  it('lifts suppression on a SET intent so clear -> set SAME objective is accepted (QA-CHIP-4)', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    tracker.recordIntent({ kind: 'clear', baselineUuid: 'g-1', baselineSourceRevision: 'g-1', baselineCondition: 'ship it' });
    expect(tracker.resolveReplay(activeEvent('g-2', 'ship it'))).toBe('suppress');
    tracker.recordIntent({ kind: 'set' });
    // The user re-set the exact same objective; its active goal_status must now publish.
    expect(tracker.resolveReplay(activeEvent('g-3', 'ship it'))).toBe('accept');
  });

  it('suppresses a terminal (cancelled/complete) event for a cleared baseline (no resurrected badge)', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    tracker.recordIntent({ kind: 'clear', baselineUuid: 'g-1', baselineSourceRevision: 'g-1', baselineCondition: 'ship it' });
    expect(tracker.resolveReplay(terminalEvent('g-2', 'ship it'))).toBe('suppress');
  });

  it('accepts a terminal completion when there is no live clear (active -> complete still publishes)', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    expect(tracker.resolveReplay(terminalEvent('g-9', 'ship it'))).toBe('accept');
  });

  it('exposes a monotonic epoch and the clear baseline on its snapshot', () => {
    const tracker = createClaudeGoalControlEpochTracker();
    const start = tracker.snapshot().epoch;
    tracker.recordIntent({ kind: 'clear', baselineUuid: 'g-1', baselineSourceRevision: 'rev-1', baselineCondition: 'ship it' });
    const afterClear = tracker.snapshot();
    expect(afterClear.epoch).toBe(start + 1);
    expect(afterClear.clear).toMatchObject({ epoch: start + 1, baselineUuid: 'g-1', baselineSourceRevision: 'rev-1' });
    tracker.recordIntent({ kind: 'set' });
    const afterSet = tracker.snapshot();
    expect(afterSet.epoch).toBe(start + 2);
    expect(afterSet.lastSetEpoch).toBe(start + 2);
    expect(afterSet.clear).toBeUndefined();
  });
});
