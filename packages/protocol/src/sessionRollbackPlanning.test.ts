import { describe, expect, it } from 'vitest';

import { resolveSessionRollbackPlan } from './sessionRollbackPlanning.js';

describe('resolveSessionRollbackPlan', () => {
  const completedTurns = [
    { userMessageSeq: 3, startSeqInclusive: 3, endSeqInclusive: 6 },
    { userMessageSeq: 7, startSeqInclusive: 7, endSeqInclusive: 11 },
    { userMessageSeq: 12, startSeqInclusive: 12, endSeqInclusive: 15 },
  ] as const;

  it('plans latest_turn rollback from the latest active turn', () => {
    expect(resolveSessionRollbackPlan({ target: { type: 'latest_turn' }, completedTurns })).toEqual({
      numTurns: 1,
      targetUserMessageSeq: 12,
      range: { startSeqInclusive: 12, endSeqInclusive: 15 },
    });
  });

  it('plans before_user_message rollback by trimming the active suffix of turns', () => {
    expect(
      resolveSessionRollbackPlan({
        target: { type: 'before_user_message', userMessageSeq: 7 },
        completedTurns,
      }),
    ).toEqual({
      numTurns: 2,
      targetUserMessageSeq: 7,
      range: { startSeqInclusive: 7, endSeqInclusive: 15 },
    });
  });

  it('preserves the targeted user-message seq even when the rollback range starts earlier', () => {
    expect(
      resolveSessionRollbackPlan({
        target: { type: 'before_user_message', userMessageSeq: 7 },
        completedTurns: [
          { userMessageSeq: 3, startSeqInclusive: 1, endSeqInclusive: 4 },
          { userMessageSeq: 7, startSeqInclusive: 5, endSeqInclusive: 10 },
        ],
      }),
    ).toEqual({
      numTurns: 1,
      targetUserMessageSeq: 7,
      range: { startSeqInclusive: 5, endSeqInclusive: 10 },
    });
  });

  it('returns null when the targeted user message is no longer in active turns', () => {
    expect(
      resolveSessionRollbackPlan({
        target: { type: 'before_user_message', userMessageSeq: 2 },
        completedTurns,
      }),
    ).toBeNull();
  });
});
