import { describe, expect, it } from 'vitest';
import { WorkflowTriggerSetV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

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

describe('resolveSessionReviewSuggestion', () => {
  const base = {
    sessionId: 'session-1',
    thinking: false,
    habitOn: false,
    changeSet,
    reviews: [],
  };

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
