import type { SessionTurnV1 } from '@happier-dev/protocol';

function containsTargetSeq(turn: SessionTurnV1, targetSeqInclusive: number): boolean {
  const anchors = turn.transcriptAnchors;
  if (!anchors) return false;
  if (anchors.startUserMessageSeq === targetSeqInclusive) return true;
  if (anchors.userMessageSeqs?.includes(targetSeqInclusive)) return true;
  return (
    typeof anchors.startSeqInclusive === 'number'
    && typeof anchors.endSeqInclusive === 'number'
    && anchors.startSeqInclusive <= targetSeqInclusive
    && targetSeqInclusive <= anchors.endSeqInclusive
  );
}

export function resolveProviderCheckpointForFork(params: Readonly<{
  targetSeqInclusive: number;
  turns: readonly SessionTurnV1[];
}>): Readonly<{
  turnId: string;
  providerCheckpoint: NonNullable<
    NonNullable<SessionTurnV1['transcriptAnchors']>['providerCheckpoint']
  >;
}> | null {
  if (!Number.isSafeInteger(params.targetSeqInclusive) || params.targetSeqInclusive < 0) return null;
  const candidates = params.turns.filter((turn) => (
    turn.rollback?.state === 'eligible'
    && turn.transcriptAnchors?.providerCheckpoint !== undefined
    && containsTargetSeq(turn, params.targetSeqInclusive)
  ));
  if (candidates.length !== 1) return null;
  const turn = candidates[0]!;
  return Object.freeze({
    turnId: turn.turnId,
    providerCheckpoint: turn.transcriptAnchors!.providerCheckpoint!,
  });
}
