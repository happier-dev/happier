import { describe, expect, it } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { SessionTurnV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';

const { isSessionReviewHabitOn, resolveSessionReviewSuggestion } =
  await import('./sessionReviewSuggestionDecision');

const turn = (turnId: string, endSeqInclusive: number) => ({
  turnId,
  seqRange: { startSeqInclusive: endSeqInclusive - 1, endSeqInclusive },
});
const changeSet = {
  turns: [turn('t1', 10), turn('t2', 20)],
  files: [
    { filePath: 'a.ts', turns: ['t1'] },
    { filePath: 'b.ts', turns: ['t2'] },
    { filePath: 'c.ts', turns: ['t1', 't2'] },
  ],
};
const completed = (sourceSessionSeq: number) => ({
  state: 'completed' as const,
  sourceSessionId: 'session-1',
  sourceSessionSeq,
});
const completion = (turnId: string, changedFiles?: boolean | null) => SessionTurnV1Schema.parse({
  turnId, status: 'completed', startedAt: 1, updatedAt: 2,
  ...(changedFiles === undefined ? {} : { automationLifecycleFacts: { changedFiles } }),
});

describe('resolveSessionReviewSuggestion', () => {
  const base = {
    sessionId: 'session-1',
    thinking: false,
    latestTurnId: 't2',
    turns: [completion('t2', true)],
    habitOn: false,
    changeSet,
    reviews: [],
  };

  it.each([false, null, undefined])('does not repeat older unreviewed changes after a turn with changedFiles=%s', changedFiles => {
    expect(resolveSessionReviewSuggestion({ ...base, latestTurnId: 't3',
      turns: [...base.turns, completion('t3', changedFiles)] })).toBeNull();
  });
  it('does not reuse a previous true fact when the latest turn is absent, unknown, or not completed', () => {
    expect(resolveSessionReviewSuggestion({ ...base, latestTurnId: 't3' })).toBeNull();
    expect(resolveSessionReviewSuggestion({ ...base, latestTurnId: null })).toBeNull();
    expect(resolveSessionReviewSuggestion({ ...base, turns: null })).toBeNull();
    for (const status of ['in_progress', 'failed', 'cancelled'] as const) {
      expect(resolveSessionReviewSuggestion({ ...base, turns: [{ ...base.turns[0]!, status }] })).toBeNull();
    }
  });

  it('says how many changed files no completed Review of this Session has covered, from the coverage owner', () => {
    expect(resolveSessionReviewSuggestion(base)).toEqual({
      unreviewedCount: 3,
    });
    // A Review that started after turn 1 covers a.ts; b.ts and c.ts changed again in turn 2.
    expect(
      resolveSessionReviewSuggestion({ ...base, reviews: [completed(15)] }),
    ).toEqual({ unreviewedCount: 2 });
  });
  it('says nothing once every change is reviewed, while the agent is working, or while a review habit is on', () => {
    expect(
      resolveSessionReviewSuggestion({ ...base, reviews: [completed(25)] }),
    ).toBeNull();
    expect(
      resolveSessionReviewSuggestion({ ...base, thinking: true }),
    ).toBeNull();
    expect(
      resolveSessionReviewSuggestion({ ...base, habitOn: true }),
    ).toBeNull();
  });
  it("says nothing until both the changes and the Session's Reviews are read", () => {
    expect(
      resolveSessionReviewSuggestion({ ...base, changeSet: null }),
    ).toBeNull();
    expect(
      resolveSessionReviewSuggestion({ ...base, reviews: null }),
    ).toBeNull();
  });
});

describe('isSessionReviewHabitOn', () => {
  const lifecycle = (id: string, enabled: boolean, extra: object = {}) => ({
    id,
    revision: 1,
    enabled,
    createdAt: 1,
    updatedAt: 1,
    kind: 'sessionLifecycle',
    triggerDefinitionEnvelope: 'opened-definition',
    events: ['parentTurnCompleted'],
    policy: { kind: 'everyMatch' },
    remainingOccurrences: null,
    status: { state: 'waiting', runId: null },
    ...extra,
  });
  const set = (
    automationId: string,
    ref: string,
    trigger: object,
    scopeSessionId: string | null,
  ) =>
    WorkflowTriggerSetV1Schema.parse({
      automationId,
      revision: 1,
      enabled: true,
      health: 'available',
      scopeSessionId,
      target: { kind: 'workflow', ref },
      triggers: [trigger],
    });
  const review = 'builtin:review-and-converge';

  it("is on when this Session's review trigger or the all-sessions review habit is on", () => {
    expect(
      isSessionReviewHabitOn(
        [set('s', review, lifecycle('t', true), 'session-1')],
        [],
      ),
    ).toBe(true);
    expect(
      isSessionReviewHabitOn(
        [],
        [set('a', review, lifecycle('t', true), null)],
      ),
    ).toBe(true);
  });
  it('is off when the review trigger is off or another workflow runs each turn', () => {
    expect(
      isSessionReviewHabitOn(
        [set('s', review, lifecycle('t', false), 'session-1')],
        [],
      ),
    ).toBe(false);
    expect(
      isSessionReviewHabitOn(
        [
          set(
            's',
            '00000000-0000-4000-8000-000000000001',
            lifecycle('t', true),
            'session-1',
          ),
        ],
        [],
      ),
    ).toBe(false);
  });
});
