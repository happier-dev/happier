import { describe, expect, it } from 'vitest';

import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/sessions/work-state';

import { createClaudeGoalWorkStateSource } from './goalSource.js';

function createHarness(currentClaudeSessionId: string | null) {
  const published: SessionWorkStateV1[] = [];
  const source = createClaudeGoalWorkStateSource({
    backendId: 'claude',
    agentId: 'claude',
    publishWorkStateSnapshot: (snapshot) => { published.push(snapshot); },
    getCurrentClaudeSessionId: () => currentClaudeSessionId,
  });
  return { published, source };
}

describe('createClaudeGoalWorkStateSource', () => {
  it('observes a goal_status attachment on the transcript stream and publishes an active goal', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.items[0]).toMatchObject({ kind: 'goal', status: 'active', title: 'Reach the goal' });
    // Fail-closed: capability absent until /goal support is observed.
    expect(published[0]?.items[0]?.goalCapabilities).toBeUndefined();
  });

  it('reads /goal capability from a system/init slash_commands row on the same stream', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    // System/init record carries slash_commands → republish with capability.
    source.observeTranscriptMessage({ type: 'system', uuid: 'sys', slash_commands: ['model', 'goal', 'clear'] });
    expect(published).toHaveLength(2);
    expect(published[1]?.items[0]?.goalCapabilities).toEqual({ canEdit: true, canClear: true });
  });

  it('ignores non-goal rows and unknown attachment subtypes', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({ type: 'assistant', uuid: 'a', message: { content: [] } });
    source.observeTranscriptMessage({ type: 'attachment', uuid: 'q', sessionId: 's1', attachment: { type: 'queued_command', prompt: 'hi' } });
    source.observeTranscriptMessage({ type: 'system', uuid: 'sys', slash_commands: ['model'] }); // no 'goal'
    expect(published).toHaveLength(0);
  });

  it('is fail-closed when a system/init slash_commands row omits /goal', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'g' },
    });
    // The transcript stream is the only slash_commands ingress: a system/init row
    // without 'goal' must not flip the capability or republish (fail-closed).
    source.observeTranscriptMessage({ type: 'system', uuid: 'sys', slash_commands: ['model', 'clear'] });
    expect(published).toHaveLength(1);
    expect(published[0]?.items[0]?.goalCapabilities).toBeUndefined();
  });

  // QA-CHIP-3 (self-learning Claude session id): the cross-session guard must be driven by the
  // CLAUDE transcript session id, learned from the channel's establishing records — not by any
  // externally-injected value that might be unset (timing race) or stale (resume tail-bleed).
  it('self-learns the Claude session id from an establishing record and accepts that session\'s goal_status even with no injected id', () => {
    // Seed is null (e.g. the unified-terminal provider session id not yet adopted when the first
    // rows arrive): the guard must still accept this channel's own goal_status by learning the id.
    const { published, source } = createHarness(null);
    // An establishing system row defines the channel's Claude session id.
    source.observeTranscriptMessage({ type: 'system', uuid: 'sys', sessionId: 'claude-xyz', slash_commands: ['goal'] });
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 'claude-xyz',
      attachment: { type: 'goal_status', met: false, condition: 'Reach it' },
    });
    expect(published.some((s) => s.items[0]?.status === 'active' && s.items[0]?.title === 'Reach it')).toBe(true);
  });

  it('accepts the first goal_status before any establishing record (guard is a no-op until the id is known)', () => {
    // No establishing record yet AND null seed → the guard is a no-op (accept), mirroring happy when
    // claudeSessionId is unknown. The first goal_status the session emits must never be dropped.
    const { published, source } = createHarness(null);
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 'claude-abc',
      attachment: { type: 'goal_status', met: false, condition: 'First goal' },
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.items[0]).toMatchObject({ status: 'active', title: 'First goal' });
  });

  it('still drops a goal_status from a genuinely foreign session once the channel id is established', () => {
    const { published, source } = createHarness(null);
    source.observeTranscriptMessage({ type: 'assistant', uuid: 'a1', sessionId: 'claude-current', message: { content: [] } });
    // A foreign session id (e.g. resume tail-bleed) must be rejected.
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 'claude-foreign',
      attachment: { type: 'goal_status', met: false, condition: 'Foreign goal' },
    });
    expect(published).toHaveLength(0);
  });

  it('never lets a goal_status attachment self-authorize the channel id', () => {
    const { published, source } = createHarness(null);
    // The establishing record sets the channel to 'real'.
    source.observeTranscriptMessage({ type: 'user', uuid: 'usr', sessionId: 'real', message: { content: 'hi' } });
    // A goal_status carrying a DIFFERENT sessionId must not adopt that id — it is the thing being
    // guarded, so it is dropped against the established channel id.
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 'spoofed',
      attachment: { type: 'goal_status', met: false, condition: 'Spoofed goal' },
    });
    expect(published).toHaveLength(0);
  });

  // QA-CHIP-4: the ACTIVE-session clear effector removes the goal item by publishing an empty
  // goal-owned snapshot (Claude's `/goal clear` emits no goal_status the source could observe).
  it('clearGoalWorkState publishes an empty goal-owned snapshot and suppresses resurrection of the cleared goal', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(published).toHaveLength(1);

    source.clearGoalWorkState();
    expect(published).toHaveLength(2);
    expect(published[1]?.items).toEqual([]);
    expect(published[1]?.primaryItemId).toBeNull();

    // Claude keeps re-publishing the same un-meetable goal as active → suppressed (no resurrection).
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u2',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(published).toHaveLength(2);
  });

  // D2: the slash-prefixed `/goal` shape on the system/init row must enable the capability too (the
  // shared normalizer handles both shapes); the raw includes('goal') path missed this.
  it('reads /goal capability from a slash-prefixed slash_commands entry', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    source.observeTranscriptMessage({ type: 'system', uuid: 'sys', slash_commands: ['model', '/goal'] });
    const latest = published[published.length - 1];
    expect(latest?.items[0]?.goalCapabilities).toEqual({ canEdit: true, canClear: true });
  });

  // QA-CHIP-4 (source level): clear -> recordGoalSetIntent -> set the SAME objective must publish the
  // active goal again (the set intent lifts the epoch suppression armed by the clear).
  it('recordGoalSetIntent lets clear -> set the same objective publish again', () => {
    const { published, source } = createHarness('s1');
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u1',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    source.clearGoalWorkState();
    expect(published).toHaveLength(2);

    // The active set effector records a SET intent before the provider echoes the goal_status.
    source.recordGoalSetIntent();
    source.observeTranscriptMessage({
      type: 'attachment',
      uuid: 'u2',
      sessionId: 's1',
      attachment: { type: 'goal_status', met: false, condition: 'Reach the goal' },
    });
    expect(published).toHaveLength(3);
    expect(published[2]?.items[0]).toMatchObject({ kind: 'goal', status: 'active', title: 'Reach the goal' });
  });
});

describe('createClaudeGoalWorkStateSource — live usage accumulation (G-3/E)', () => {
  const SESSION_ID = 's1';
  const NOW_BASE = 1_000_000;

  function activeGoalAttachment(params: Readonly<{ uuid: string; condition: string }>): unknown {
    return { type: 'attachment', uuid: params.uuid, sessionId: SESSION_ID, attachment: { type: 'goal_status', met: false, condition: params.condition } };
  }

  function assistantWithUsage(params: Readonly<{ inputTokens: number; outputTokens: number; endTurn?: boolean; timestamp?: string; isSidechain?: boolean }>): unknown {
    return {
      type: 'assistant',
      uuid: `a-${Math.random()}`,
      sessionId: SESSION_ID,
      isSidechain: params.isSidechain === true,
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
      publishWorkStateSnapshot: (snapshot) => { published.push(snapshot); },
      getCurrentClaudeSessionId: () => SESSION_ID,
      now: () => now,
    });
    return { source, published, advance: (ms: number) => { now += ms; } };
  }

  const goalItem = (snapshot: SessionWorkStateV1 | undefined) => snapshot?.items[0];

  it('accumulates per-turn tokens + elapsed into the active goal on a turn boundary', () => {
    const { source, published, advance } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const afterGoal = published.length;
    advance(30_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 800, outputTokens: 400, endTurn: true }));
    expect(published.length).toBe(afterGoal + 1);
    expect(goalItem(published[published.length - 1])).toMatchObject({ status: 'active', tokensUsed: 1200, timeUsedSeconds: 30 });
  });

  it('does NOT republish per streaming delta — only on the turn boundary', () => {
    const { source, published } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    const afterGoal = published.length;
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50 }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 100, outputTokens: 50 }));
    expect(published.length).toBe(afterGoal);
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
    source.observeTranscriptMessage({
      type: 'attachment', uuid: 'g-2', sessionId: SESSION_ID, timestamp: '2026-06-24T00:05:00.000Z',
      attachment: { type: 'goal_status', met: true, condition: 'ship it', tokens: 2393, durationMs: 41613 },
    });
    const item = goalItem(published[published.length - 1]);
    expect(item).toMatchObject({ status: 'complete', tokensUsed: 2393 });
    expect(item?.timeUsedSeconds).toBeCloseTo(41.613, 2);
  });

  it('bills a subagent turn to the CHILD — sidechain rows never reach the parent goal meter', () => {
    const { source, published, advance } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    advance(10_000);
    // A subagent's assistant rows ride the SAME raw transcript channel, marked `isSidechain: true`.
    // They are already refused as turn BOUNDARIES, so their cost is merely HELD — and folded at the
    // parent's next boundary, which is the leak: the parent's meter grows by the child's budget.
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 40_000, outputTokens: 2_277, isSidechain: true }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 30_000, outputTokens: 1_000, endTurn: true, isSidechain: true }));
    // The parent's own completed turn: only ITS 600 tokens are the parent's to bill.
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true }));
    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 600 });
  });

  it('does not accumulate usage when there is no active goal', () => {
    const { source, published } = createUsageSource();
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true }));
    expect(published).toHaveLength(0);
  });

  it('reseeds the accumulator from a prior published active goal item (restart continuity)', () => {
    const { source, published, advance } = createUsageSource();
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.reseedActiveGoalUsageFromPublishedItem({ status: 'active', tokensUsed: 5000, timeUsedSeconds: 100 });
    advance(110_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 200, outputTokens: 100, endTurn: true }));
    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 5300, timeUsedSeconds: 110 });
  });

  it('does not DOUBLE-COUNT historical turns re-fed by the transcript initial-replay after a restart', () => {
    const { source, published, advance } = createUsageSource();
    const floorUpdatedAtMs = Date.parse('2026-06-24T00:10:00.000Z');
    source.reseedActiveGoalUsageFromPublishedItem({ status: 'active', tokensUsed: 600, timeUsedSeconds: 100, updatedAt: floorUpdatedAtMs });
    // Initial-replay re-feeds the historical goal_status + the historical assistant turn (both stamped
    // BEFORE the floor); neither must re-fold on top of the reseeded floor.
    source.observeTranscriptMessage(activeGoalAttachment({ uuid: 'g-1', condition: 'ship it' }));
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 500, outputTokens: 100, endTurn: true, timestamp: '2026-06-24T00:05:00.000Z' }));
    // A genuinely NEW turn stamped AFTER the floor basis.
    advance(110_000);
    source.observeTranscriptMessage(assistantWithUsage({ inputTokens: 200, outputTokens: 100, endTurn: true, timestamp: '2026-06-24T00:20:00.000Z' }));
    // Correct: floor 600 + new 300 = 900 (NOT 600 + replayed 600 + new 300 = 1500).
    expect(goalItem(published[published.length - 1])).toMatchObject({ tokensUsed: 900 });
  });
});
