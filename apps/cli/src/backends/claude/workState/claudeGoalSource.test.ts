import { describe, expect, it, vi } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/protocol';

import { createClaudeGoalWorkStateSource } from './claudeGoalSource';

const SOURCE_SESSION_ID = 'claude-source-session';

function activeGoalAttachment(params: Readonly<{ uuid: string; condition: string; sessionId?: string }>): unknown {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId ?? SOURCE_SESSION_ID,
    timestamp: '2026-06-24T00:00:00.000Z',
    attachment: { type: 'goal_status', met: false, condition: params.condition },
  };
}

function completedGoalAttachment(params: Readonly<{ uuid: string; condition: string; sessionId?: string }>): unknown {
  return {
    type: 'attachment',
    uuid: params.uuid,
    sessionId: params.sessionId ?? SOURCE_SESSION_ID,
    timestamp: '2026-06-24T00:01:00.000Z',
    attachment: { type: 'goal_status', met: true, condition: params.condition },
  };
}

function systemInit(params: Readonly<{ slashCommands: readonly string[] }>): unknown {
  return { type: 'system', subtype: 'init', slash_commands: params.slashCommands };
}

function createSource() {
  const published: SessionWorkStateV1[] = [];
  let currentClaudeSessionId: string | null = SOURCE_SESSION_ID;
  const source = createClaudeGoalWorkStateSource({
    backendId: 'claude',
    agentId: 'claude',
    publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
    getCurrentClaudeSessionId: () => currentClaudeSessionId,
  });
  return {
    source,
    published,
    setCurrentClaudeSessionId: (value: string | null) => {
      currentClaudeSessionId = value;
    },
  };
}

function goalItem(snapshot: SessionWorkStateV1) {
  return snapshot.items[0];
}

describe('createClaudeGoalWorkStateSource', () => {
  it('routes a goal_status attachment from a transcript message into a published active goal snapshot', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship the feature' }));

    expect(published).toHaveLength(1);
    expect(goalItem(published[0])).toMatchObject({
      id: 'goal:claude',
      kind: 'goal',
      status: 'active',
      title: 'ship the feature',
    });
  });

  it('derives goalCapabilities only after the system/init slash_commands include `goal` (fail-closed)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(goalItem(published[0]).goalCapabilities).toBeUndefined();

    source.observeTranscriptMessage(systemInit({ slashCommands: ['goal', 'compact'] }));
    expect(published).toHaveLength(2);
    expect(goalItem(published[1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  it('also accepts slash_commands fed directly (remote onCapabilities seam)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.applySlashCommands(['goal']);

    expect(goalItem(published[published.length - 1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  // G1: the `goal`/`/goal` shape parity is owned by the shared protocol normalizer, so the
  // slash-prefixed command shape (the SDK-init shape happy already accepts) also enables capabilities.
  it('derives goalCapabilities from the slash-prefixed `/goal` command shape (G1 parity)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(goalItem(published[0]).goalCapabilities).toBeUndefined();

    source.observeTranscriptMessage(systemInit({ slashCommands: ['/goal', 'compact'] }));
    expect(goalItem(published[published.length - 1]).goalCapabilities).toMatchObject({ canEdit: true, canClear: true });
  });

  // G-6: on graceful CLI teardown, an active goal is republished with statusReason:'interrupted'.
  it('finalizeInterruptedGoalOnShutdown republishes an active goal with statusReason:interrupted', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const beforeCount = published.length;

    source.finalizeInterruptedGoalOnShutdown();

    expect(published.length).toBe(beforeCount + 1);
    expect(goalItem(published[published.length - 1])).toMatchObject({
      id: 'goal:claude',
      status: 'active',
      statusReason: 'interrupted',
    });
  });

  it('finalizeInterruptedGoalOnShutdown is a no-op when the goal already completed', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(completedGoalAttachment({ uuid: 'g-2', condition: 'ship it' }));
    const beforeCount = published.length;

    source.finalizeInterruptedGoalOnShutdown();

    expect(published.length).toBe(beforeCount);
  });

  it('finalizeInterruptedGoalOnShutdown is a no-op when no goal was ever observed', () => {
    const { source, published } = createSource();
    source.finalizeInterruptedGoalOnShutdown();
    expect(published).toHaveLength(0);
  });

  it('transitions an active goal to complete on a met:true attachment', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(completedGoalAttachment({ uuid: 'g-2', condition: 'ship it' }));

    expect(goalItem(published[published.length - 1])).toMatchObject({ status: 'complete' });
  });

  it('ignores goal_status attachments from a foreign source session (cross-session guard)', () => {
    const { source, published } = createSource();

    // Establish the channel's Claude session id first (a record carrying SOURCE_SESSION_ID), then a
    // foreign-session attachment must be rejected as cross-session contamination.
    source.observeTranscriptMessage(systemInit({ slashCommands: ['goal'] }));
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'other-session' }));

    expect(published).toHaveLength(0);
  });

  it('accepts goal_status whose sessionId matches the channel-established Claude id even when the injected getter returns a non-matching (Happier) id', () => {
    // Production reality: the launcher feeds the HAPPIER session id (e.g. `cmqs...`) into the getter,
    // which never equals the Claude transcript `sessionId` (`b27b...`). The source therefore learns
    // the Claude session id from the channel's establishing records (system/assistant/user) and
    // matches goal_status against THAT — otherwise EVERY goal_status is dropped (manual-QA-found
    // regression). The injected getter is only a pre-observation seed.
    const published: SessionWorkStateV1[] = [];
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      // Happier session id, deliberately different from the transcript `sessionId`.
      getCurrentClaudeSessionId: () => 'cmqs-happier-session-id',
    });

    // An establishing record (a system record carrying the Claude transcript sessionId) precedes the
    // goal_status, exactly as on a real transcript channel.
    source.observeTranscriptMessage({ type: 'system', subtype: 'informational', sessionId: 'b27b-claude-session' });
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'b27b-claude-session' }));

    expect(published).toHaveLength(1);
    expect(goalItem(published[0])).toMatchObject({ status: 'active', title: 'ship it' });
  });

  it('accepts the FIRST goal_status when no Claude session id is established yet (guard no-op, mirrors happy)', () => {
    // If a goal_status is the first thing observed (no establishing record, getter returns the wrong
    // Happier id), the guard must be a no-op (accept) so the feature is not dead — matching happy,
    // whose guard is skipped while `claudeSessionId` is unknown.
    const published: SessionWorkStateV1[] = [];
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      getCurrentClaudeSessionId: () => null,
    });

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it', sessionId: 'b27b-claude-session' }));

    expect(published).toHaveLength(1);
  });

  it('ignores non-goal transcript messages and unknown attachment subtypes', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage({ type: 'assistant', message: { content: [] } });
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'a-1',
      sessionId: SOURCE_SESSION_ID,
      attachment: { type: 'skill_listing' },
    });

    expect(published).toHaveLength(0);
  });

  it('does not republish for a duplicate goal_status uuid', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));

    expect(published).toHaveLength(1);
  });

  it('clearGoalWorkState publishes an empty goal snapshot (deterministic active-clear removal)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    expect(published[0].items).toHaveLength(1);

    source.clearGoalWorkState();

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(0);
    expect(last.primaryItemId).toBeNull();
  });

  it('suppresses a just-cleared goal that Claude keeps re-evaluating as active (same condition)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    const afterClear = published.length;
    // Claude re-evaluates the un-meetable goal as active AGAIN (distinct uuid, same condition): this
    // must NOT resurrect the badge the user just cleared.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'rewrite the kernel' }));

    expect(published).toHaveLength(afterClear);
    expect(published[afterClear - 1].items).toHaveLength(0);
  });

  it('re-publishes a DIFFERENT goal set after a clear (suppression is condition-scoped)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    // A genuinely new goal (different condition) lifts the suppression and publishes normally.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'add tests' }));

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(1);
    expect(goalItem(last)).toMatchObject({ status: 'active', title: 'add tests' });
  });

  it('recordGoalSetIntent re-publishes the SAME objective set after a clear (G2/QA-CHIP-4 live flow)', () => {
    const { source, published } = createSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'rewrite the kernel' }));
    source.clearGoalWorkState();
    // Stale re-evaluation of the cleared goal is still suppressed.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-2', condition: 'rewrite the kernel' }));
    const afterClear = published.length;
    expect(published[afterClear - 1].items).toHaveLength(0);

    // The user re-sets the EXACT same objective via the chip → the set effector records the intent →
    // the resulting active goal_status must publish (the old clearedCondition tombstone broke this).
    source.recordGoalSetIntent();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-3', condition: 'rewrite the kernel' }));

    const last = published[published.length - 1];
    expect(last.items).toHaveLength(1);
    expect(goalItem(last)).toMatchObject({ status: 'active', title: 'rewrite the kernel' });
  });

  it('is robust to a publish callback that throws (best-effort)', () => {
    const publishWorkStateSnapshot = vi.fn(() => {
      throw new Error('publish failed');
    });
    const throwingSource = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot,
      getCurrentClaudeSessionId: () => SOURCE_SESSION_ID,
    });

    expect(() => throwingSource.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }))).not.toThrow();
    expect(publishWorkStateSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('createClaudeGoalWorkStateSource — live usage accumulation (G-3/E)', () => {
  const NOW_BASE = 1_000_000;

  function assistantWithUsage(params: Readonly<{
    inputTokens: number;
    outputTokens: number;
    endTurn?: boolean;
    timestamp?: string;
    isSidechain?: boolean;
  }>): unknown {
    return {
      type: 'assistant',
      sessionId: SOURCE_SESSION_ID,
      isSidechain: params.isSidechain ?? false,
      ...(params.timestamp ? { timestamp: params.timestamp } : {}),
      message: {
        role: 'assistant',
        ...(params.endTurn ? { stop_reason: 'end_turn' } : {}),
        content: [{ type: 'text', text: 'working' }],
        usage: { input_tokens: params.inputTokens, output_tokens: params.outputTokens },
      },
    };
  }

  function createUsageSource() {
    const published: SessionWorkStateV1[] = [];
    let now = NOW_BASE;
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot: (snapshot) => published.push(snapshot),
      getCurrentClaudeSessionId: () => SOURCE_SESSION_ID,
      now: () => now,
    });
    return {
      source,
      published,
      advance: (ms: number) => { now += ms; },
    };
  }

  it('accumulates per-turn tokens + elapsed into the active goal on a turn boundary', () => {
    const { source, published, advance } = createUsageSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const afterGoal = published.length;

    advance(30_000); // 30s of wall-time
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 800, outputTokens: 400, endTurn: true }));

    expect(published.length).toBe(afterGoal + 1);
    const item = goalItem(published[published.length - 1]);
    expect(item).toMatchObject({ status: 'active', tokensUsed: 1200, timeUsedSeconds: 30 });
  });

  it('does NOT republish per streaming delta — only on the turn boundary', () => {
    const { source, published } = createUsageSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const afterGoal = published.length;

    // Intermediate assistant deltas (no end_turn) accrue usage but must not publish.
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50 }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50 }));
    expect(published.length).toBe(afterGoal);

    // The end_turn boundary publishes ONCE with the whole turn's accrued total (150 × 3 = 450).
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50, endTurn: true }));
    expect(published.length).toBe(afterGoal + 1);
    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 450 });
  });

  it('accumulates across multiple turns', () => {
    const { source, published, advance } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));

    advance(10_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true }));
    advance(15_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 200, outputTokens: 100, endTurn: true }));

    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 900, timeUsedSeconds: 25 });
  });

  it('provider totals WIN on completion — met:true replaces the accumulated estimate', () => {
    const { source, published, advance } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    advance(20_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 9000, outputTokens: 1000, endTurn: true }));

    // The provider's authoritative completion totals overwrite the accumulator.
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'g-2',
      sessionId: SOURCE_SESSION_ID,
      timestamp: '2026-06-24T00:05:00.000Z',
      attachment: { type: 'goal_status', met: true, condition: 'ship it', tokens: 2393, durationMs: 41613 },
    });

    const item = goalItem(published[published.length - 1]);
    expect(item).toMatchObject({ status: 'complete', tokensUsed: 2393 });
    expect(item.timeUsedSeconds).toBeCloseTo(41.613, 2);
  });

  // D-7 / N-USAGE: a subagent's assistant turns ride the SAME raw transcript channel as the parent's,
  // distinguished only by `isSidechain: true`. Their tokens are the CHILD's cost and must never be
  // billed to the parent goal's meter. Three sibling readers on this channel already carry the guard
  // (readClaudeTranscriptTurnSignal, sdkToLogConverter, createClaudeRawMessageTurnDiffBridge).
  it('does NOT bill a subagent (sidechain) assistant turn to the parent goal meter', () => {
    const { source, published, advance } = createUsageSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const afterGoal = published.length;

    // A subagent burns a large budget of its own. Even carrying `stop_reason:'end_turn'`, a sidechain
    // row is not a parent turn boundary, so it must neither publish nor leave accrued tokens behind.
    source.observeTranscriptMessage(assistantWithUsage({
      inputTokens: 40_000,
      outputTokens: 10_000,
      endTurn: true,
      isSidechain: true,
    }));
    expect(published.length).toBe(afterGoal);

    advance(30_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 800, outputTokens: 400, endTurn: true }));

    expect(published.length).toBe(afterGoal + 1);
    expect(goalItem(published[published.length - 1])).toMatchObject({
      status: 'active',
      tokensUsed: 1200,
      timeUsedSeconds: 30,
    });
  });

  // A sidechain turn that never ends the parent turn must also not leak into a LATER parent fold —
  // the guard belongs at the read, not at the boundary, so nothing is left in the accumulator.
  it('does not carry sidechain tokens into a subsequent parent turn boundary', () => {
    const { source, published } = createUsageSource();

    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));

    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 7_000, outputTokens: 3_000, isSidechain: true }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50 }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50, endTurn: true }));

    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 300 });
  });

  it('does not accumulate usage when there is no active goal', () => {
    const { source, published } = createUsageSource();
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true }));
    expect(published).toHaveLength(0);
  });

  it('reseeds the accumulator from a prior published active goal item (restart continuity)', () => {
    const { source, published, advance } = createUsageSource();

    // A restart replays the transcript: the source re-observes the active goal_status (fresh tracker,
    // resets to zero), THEN the launcher reseeds the accumulator from the last-published metadata item
    // so subsequent folds continue the running total instead of restarting from zero.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.reseedActiveGoalUsageFromPublishedItem({ status: 'active', tokensUsed: 5000, timeUsedSeconds: 100 });
    advance(110_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 200, outputTokens: 100, endTurn: true }));

    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 5300, timeUsedSeconds: 110 });
  });

  it('does not DOUBLE-COUNT historical turns re-fed by the transcript initial-replay after a restart', () => {
    // Production restart: the scanner re-feeds the WHOLE transcript on the raw channel (initial-replay
    // is NOT suppressed for the goal source when replaySuppressRowsBeforeMs is unset — the default).
    // The launcher reseeds the floor from the last-published item, which ALREADY accounts for the
    // historical turns. If the fold path re-folds those replayed historical assistant turns on top of
    // the reseeded floor, the mid-run token/elapsed figure balloons (double-count).
    const { source, published, advance } = createUsageSource();

    // Floor from the prior run's last-published active goal item (accounts for 600 tokens / 100s),
    // published at wall-time `updatedAt` (the historical-replay cutoff).
    const floorUpdatedAtMs = Date.parse('2026-06-24T00:10:00.000Z');
    source.reseedActiveGoalUsageFromPublishedItem({ status: 'active', tokensUsed: 600, timeUsedSeconds: 100, updatedAt: floorUpdatedAtMs });

    // Transcript initial-replay re-feeds the historical goal_status + the historical assistant turn
    // that produced those 600 tokens (both are on disk, unsuppressed, timestamped BEFORE the floor).
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true, timestamp: '2026-06-24T00:05:00.000Z' }));

    // A genuinely NEW turn (timestamped AFTER the floor basis) after the live tail resumes.
    advance(110_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 200, outputTokens: 100, endTurn: true, timestamp: '2026-06-24T00:20:00.000Z' }));

    // Correct: floor 600 + new turn 300 = 900. NOT 600 + replayed 600 + new 300 = 1500.
    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 900 });
  });
});

describe('createClaudeGoalWorkStateSource — publish robustness', () => {
  it('is robust to a publish callback that throws (best-effort)', () => {
    const publishWorkStateSnapshot = vi.fn(() => {
      throw new Error('publish failed');
    });
    const source = createClaudeGoalWorkStateSource({
      backendId: 'claude',
      agentId: 'claude',
      publishWorkStateSnapshot,
      getCurrentClaudeSessionId: () => SOURCE_SESSION_ID,
    });

    expect(() => source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }))).not.toThrow();
    expect(publishWorkStateSnapshot).toHaveBeenCalledTimes(1);
  });
});
