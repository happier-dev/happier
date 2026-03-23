import type { SessionRollbackRangeV1 } from '../sessionMetadata/sessionRollbackRangesV1.js';
import type { TurnChangeSet } from './types.js';

function isTurnInsideRollbackRange(turn: TurnChangeSet, range: SessionRollbackRangeV1): boolean {
  return turn.seqRange.startSeqInclusive >= range.startSeqInclusive
    && turn.seqRange.endSeqInclusive <= range.endSeqInclusive;
}

export function excludeRolledBackTurns(params: Readonly<{
  turns: readonly TurnChangeSet[];
  rollbackRanges: readonly SessionRollbackRangeV1[];
}>): TurnChangeSet[] {
  if (params.rollbackRanges.length === 0) return [...params.turns];
  return params.turns.filter((turn) => !params.rollbackRanges.some((range) => isTurnInsideRollbackRange(turn, range)));
}
