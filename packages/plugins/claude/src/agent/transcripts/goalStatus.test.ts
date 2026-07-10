import { describe, expect, it } from 'vitest';

import {
  buildEmptyClaudeGoalWorkStateSnapshot,
  CLAUDE_GOAL_WORK_STATE_ITEM_ID,
  CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES,
  createClaudeGoalStatusWorkStateTracker,
  mapClaudeGoalStatusEventToWorkStateItem,
  parseClaudeGoalStatusAttachment,
} from './goalStatus.js';

function goalStatusRow(params: Readonly<{
  uuid: string;
  sessionId: string;
  met: boolean;
  condition: string;
  sentinel?: boolean;
  tokens?: number;
  durationMs?: number;
}>): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId,
    attachment: {
      type: 'goal_status',
      met: params.met,
      condition: params.condition,
      ...(params.sentinel !== undefined ? { sentinel: params.sentinel } : {}),
      ...(params.tokens !== undefined ? { tokens: params.tokens } : {}),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
    },
  };
}

describe('parseClaudeGoalStatusAttachment', () => {
  it('parses a well-formed goal_status attachment', () => {
    const event = parseClaudeGoalStatusAttachment(goalStatusRow({
      uuid: 'u1',
      sessionId: 's1',
      met: false,
      condition: 'Ship the goal feature',
    }));
    expect(event).toMatchObject({
      type: 'goal_status',
      uuid: 'u1',
      sourceSessionId: 's1',
      attachment: { met: false, condition: 'Ship the goal feature' },
    });
  });

  it('returns null for non-attachment rows and other attachment subtypes', () => {
    expect(parseClaudeGoalStatusAttachment({ type: 'system', uuid: 'x', slash_commands: ['goal'] })).toBeNull();
    expect(parseClaudeGoalStatusAttachment({
      type: 'attachment',
      uuid: 'x',
      attachment: { type: 'queued_command', prompt: 'hi' },
    })).toBeNull();
    expect(parseClaudeGoalStatusAttachment({
      type: 'attachment',
      uuid: 'x',
      attachment: { type: 'goal_status', condition: 'no met flag' },
    })).toBeNull();
  });
});

describe('mapClaudeGoalStatusEventToWorkStateItem', () => {
  it('maps active goals and gates capabilities on /goal support (fail-closed)', () => {
    const event = parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'u1', sessionId: 's1', met: false, condition: 'Do it' }))!;
    // Capability absent when /goal support is unknown (fail-closed).
    const withoutSupport = mapClaudeGoalStatusEventToWorkStateItem(event, { backendId: 'claude', updatedAt: 10 });
    expect(withoutSupport).toMatchObject({ id: CLAUDE_GOAL_WORK_STATE_ITEM_ID, kind: 'goal', status: 'active', title: 'Do it' });
    expect(withoutSupport?.goalCapabilities).toBeUndefined();
    // Capability present (edit + clear only) once /goal is supported.
    const withSupport = mapClaudeGoalStatusEventToWorkStateItem(event, { backendId: 'claude', updatedAt: 10, goalCommandSupported: true });
    expect(withSupport?.goalCapabilities).toEqual({ canEdit: true, canClear: true });
  });

  it('maps completed vs cleared goals from met + sentinel', () => {
    const completed = parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'c', sessionId: 's1', met: true, condition: 'g', tokens: 42, durationMs: 2000 }))!;
    expect(mapClaudeGoalStatusEventToWorkStateItem(completed, { backendId: 'claude', updatedAt: 5 })).toMatchObject({
      status: 'complete',
      tokensUsed: 42,
      timeUsedSeconds: 2,
    });
    const cleared = parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'x', sessionId: 's1', met: true, condition: 'g', sentinel: true }))!;
    expect(mapClaudeGoalStatusEventToWorkStateItem(cleared, { backendId: 'claude', updatedAt: 5 })?.status).toBe('cancelled');
  });

  it('drops events from a foreign Claude session (source-session guard)', () => {
    const event = parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'u1', sessionId: 'other', met: false, condition: 'Do it' }))!;
    expect(mapClaudeGoalStatusEventToWorkStateItem(event, { backendId: 'claude', updatedAt: 10, currentClaudeSessionId: 's1' })).toBeNull();
  });
});

describe('createClaudeGoalStatusWorkStateTracker', () => {
  it('publishes latest-wins, dedupes by uuid, and republishes when /goal support flips', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude' });

    const first = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'u1', sessionId: 's1', met: false, condition: 'A' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    expect(first?.items[0]).toMatchObject({ status: 'active', title: 'A' });
    expect(first?.items[0]?.goalCapabilities).toBeUndefined();
    // The published snapshot is self-describing: it carries the goal source's
    // owned families so launchers/consumers can read them back to drive the
    // merge prune (parity with remote-dev `buildSnapshot`).
    expect((first as { ownedSourceFamilies?: readonly string[] }).ownedSourceFamilies)
      .toEqual(CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES);

    // Duplicate uuid → no republish.
    expect(tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'u1', sessionId: 's1', met: false, condition: 'A' }))!,
      { updatedAt: 2, currentClaudeSessionId: 's1' },
    )).toBeNull();

    // Slash-commands confirm /goal support → republish with edit/clear capability.
    const afterSupport = tracker.setGoalCommandSupported(true, { updatedAt: 3, currentClaudeSessionId: 's1' });
    expect(afterSupport?.items[0]?.goalCapabilities).toEqual({ canEdit: true, canClear: true });

    // No-op flip → no republish.
    expect(tracker.setGoalCommandSupported(true, { updatedAt: 4, currentClaudeSessionId: 's1' })).toBeNull();

    // New goal supersedes (latest-wins).
    const second = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'u2', sessionId: 's1', met: false, condition: 'B' }))!,
      { updatedAt: 5, currentClaudeSessionId: 's1' },
    );
    expect(second?.items[0]).toMatchObject({ status: 'active', title: 'B', goalCapabilities: { canEdit: true, canClear: true } });
  });

  // QA-CHIP-4: clearing a goal must remove it deterministically AND survive Claude's continued
  // ACTIVE re-evaluation of the same (un-meetable) condition, which would otherwise resurrect it.
  it('recordGoalControlIntent(clear) suppresses active resurrection of the cleared goal but accepts a different one', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude' });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: false, condition: 'Count grains of sand' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );

    // User clears: the tracker records a CLEAR intent and arms the epoch suppression against the
    // cleared baseline.
    tracker.recordGoalControlIntent({ kind: 'clear' });

    // Claude keeps re-evaluating the SAME un-meetable goal as active → must be suppressed (no resurrection).
    expect(tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: false, condition: 'Count grains of sand' }))!,
      { updatedAt: 2, currentClaudeSessionId: 's1' },
    )).toBeNull();

    // A genuinely different goal (new condition) lifts the suppression and publishes normally.
    const next = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g3', sessionId: 's1', met: false, condition: 'A new goal' }))!,
      { updatedAt: 3, currentClaudeSessionId: 's1' },
    );
    expect(next?.items[0]).toMatchObject({ status: 'active', title: 'A new goal' });
  });

  // QA-CHIP-4: clear -> set the SAME objective must be accepted (the epoch — not the objective text —
  // is the operation identity, so the old `clearedCondition` permanent-suppression bug is gone).
  it('recordGoalControlIntent(set) lets clear -> set SAME objective publish again', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude' });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: false, condition: 'Ship the feature' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    tracker.recordGoalControlIntent({ kind: 'clear' });
    // Stale post-clear active replay of the same objective stays suppressed...
    expect(tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: false, condition: 'Ship the feature' }))!,
      { updatedAt: 2, currentClaudeSessionId: 's1' },
    )).toBeNull();
    // ...until the user re-sets the exact same objective, which lifts the suppression.
    tracker.recordGoalControlIntent({ kind: 'set' });
    const reSet = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g3', sessionId: 's1', met: false, condition: 'Ship the feature' }))!,
      { updatedAt: 3, currentClaudeSessionId: 's1' },
    );
    expect(reSet?.items[0]).toMatchObject({ status: 'active', title: 'Ship the feature' });
  });

  // QA-CHIP-4: a stale terminal sentinel for a cleared baseline must NOT recreate a cancelled badge
  // after the app already removed the goal by clear intent (epoch design changes the old behavior
  // where `clearedCondition` let the terminal status through).
  it('recordGoalControlIntent(clear) suppresses a stale terminal sentinel for the cleared goal', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude' });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: false, condition: 'Do the thing' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    tracker.recordGoalControlIntent({ kind: 'clear' });
    // A terminal (met:true) event for the cleared goal must not resurrect a cancelled badge.
    expect(tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: true, condition: 'Do the thing', sentinel: true }))!,
      { updatedAt: 2, currentClaudeSessionId: 's1' },
    )).toBeNull();
  });

  // A terminal completion for an active, NON-cleared goal must still publish `complete`.
  it('still publishes a terminal completion when there is no live clear', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude' });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: false, condition: 'Do the thing' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    const terminal = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: true, condition: 'Do the thing' }))!,
      { updatedAt: 2, currentClaudeSessionId: 's1' },
    );
    expect(terminal?.items[0]?.status).toBe('complete');
  });
});

describe('createClaudeGoalStatusWorkStateTracker — live usage accumulation for active goals (G-3/E)', () => {
  function activeTracker() {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', agentId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: false, condition: 'ship it' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    return tracker;
  }

  it('folds per-turn tokens + elapsed wall-time into the ACTIVE goal item on a turn boundary', () => {
    const tracker = activeTracker();
    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 1200, timeUsedSeconds: 30 });
    expect(snapshot?.items[0]).toMatchObject({ status: 'active', tokensUsed: 1200, timeUsedSeconds: 30 });
    expect(snapshot?.items[0]?.statusReason).toBeUndefined();
  });

  it('accumulates tokens across successive turns (running total, not per-turn replace)', () => {
    const tracker = activeTracker();
    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 1000, timeUsedSeconds: 20 });
    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 20, currentClaudeSessionId: 's1', addTokens: 500, timeUsedSeconds: 45 });
    expect(snapshot?.items[0]).toMatchObject({ tokensUsed: 1500, timeUsedSeconds: 45 });
  });

  it('returns null (no churn) when neither tokens nor elapsed changed since the last fold', () => {
    const tracker = activeTracker();
    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 1000, timeUsedSeconds: 20 });
    expect(tracker.foldActiveGoalUsage({ updatedAt: 20, currentClaudeSessionId: 's1', addTokens: 0, timeUsedSeconds: 20 })).toBeNull();
  });

  it('is a no-op (null) when the latest goal is terminal — completed/cancelled goals do not accumulate', () => {
    const tracker = createClaudeGoalStatusWorkStateTracker({ backendId: 'claude', goalCommandSupported: true });
    tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g1', sessionId: 's1', met: true, condition: 'ship it' }))!,
      { updatedAt: 1, currentClaudeSessionId: 's1' },
    );
    expect(tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 1000, timeUsedSeconds: 20 })).toBeNull();
  });

  it('provider totals WIN on met:true — a completing goal_status replaces the accumulated estimate', () => {
    const tracker = activeTracker();
    tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 9999, timeUsedSeconds: 999 });
    const snapshot = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: true, condition: 'ship it', tokens: 42000, durationMs: 60000 }))!,
      { updatedAt: 20, currentClaudeSessionId: 's1' },
    );
    expect(snapshot?.items[0]).toMatchObject({ status: 'complete', tokensUsed: 42000, timeUsedSeconds: 60 });
  });

  it('provider totals WIN even after a reseed floor — a completing goal is not inflated by the floor', () => {
    const tracker = activeTracker();
    tracker.reseedActiveGoalUsage({ tokensUsed: 5000, timeUsedSeconds: 120 });
    tracker.foldActiveGoalUsage({ updatedAt: 5, currentClaudeSessionId: 's1', addTokens: 100, timeUsedSeconds: 125 });
    const snapshot = tracker.applyAttachment(
      parseClaudeGoalStatusAttachment(goalStatusRow({ uuid: 'g2', sessionId: 's1', met: true, condition: 'ship it', tokens: 7000, durationMs: 130000 }))!,
      { updatedAt: 20, currentClaudeSessionId: 's1' },
    );
    expect(snapshot?.items[0]).toMatchObject({ status: 'complete', tokensUsed: 7000, timeUsedSeconds: 130 });
  });

  it('reseeds the accumulator from an already-published active goal item (restart continuity)', () => {
    const tracker = activeTracker();
    tracker.reseedActiveGoalUsage({ tokensUsed: 5000, timeUsedSeconds: 120 });
    const snapshot = tracker.foldActiveGoalUsage({ updatedAt: 10, currentClaudeSessionId: 's1', addTokens: 300, timeUsedSeconds: 130 });
    expect(snapshot?.items[0]).toMatchObject({ tokensUsed: 5300, timeUsedSeconds: 130 });
  });
});

describe('buildEmptyClaudeGoalWorkStateSnapshot', () => {
  it('builds a goal-owned snapshot with no items so the merge drops the goal item', () => {
    const snapshot = buildEmptyClaudeGoalWorkStateSnapshot({ backendId: 'claude', agentId: 'claude', updatedAt: 7 });
    expect(snapshot.items).toEqual([]);
    expect(snapshot.primaryItemId).toBeNull();
    expect((snapshot as { ownedSourceFamilies?: readonly string[] }).ownedSourceFamilies)
      .toEqual(CLAUDE_GOAL_WORK_STATE_OWNED_SOURCE_FAMILIES);
  });
});
