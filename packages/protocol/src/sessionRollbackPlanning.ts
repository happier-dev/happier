import type { SessionRollbackTarget } from './sessionRollback.js';

export type CompletedConversationTurn = Readonly<{
  userMessageSeq: number;
  startSeqInclusive: number;
  endSeqInclusive: number;
}>;

export type SessionRollbackPlan = Readonly<{
  numTurns: number;
  targetUserMessageSeq: number;
  range: Readonly<{
    startSeqInclusive: number;
    endSeqInclusive: number;
  }>;
}>;

export function resolveSessionRollbackPlan(params: Readonly<{
  target: SessionRollbackTarget;
  completedTurns: readonly CompletedConversationTurn[];
}>): SessionRollbackPlan | null {
  const completedTurns = params.completedTurns;
  if (completedTurns.length === 0) return null;

  if (params.target.type === 'latest_turn') {
    const latest = completedTurns[completedTurns.length - 1];
    if (!latest) return null;
    return {
      numTurns: 1,
      targetUserMessageSeq: latest.userMessageSeq,
      range: {
        startSeqInclusive: latest.startSeqInclusive,
        endSeqInclusive: latest.endSeqInclusive,
      },
    };
  }

  const targetUserMessageSeq = params.target.userMessageSeq;
  const targetIndex = completedTurns.findIndex((turn) => turn.userMessageSeq === targetUserMessageSeq);
  if (targetIndex < 0) return null;
  const targetTurn = completedTurns[targetIndex];
  const latest = completedTurns[completedTurns.length - 1];
  if (!targetTurn || !latest) return null;

  return {
    numTurns: completedTurns.length - targetIndex,
    targetUserMessageSeq,
    range: {
      startSeqInclusive: targetTurn.startSeqInclusive,
      endSeqInclusive: latest.endSeqInclusive,
    },
  };
}
