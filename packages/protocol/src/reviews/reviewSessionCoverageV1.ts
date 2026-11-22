import type {
  SessionChangeSetFile,
  TurnChangeSet,
} from '../sessions/changes/types.js';
import type { ReviewMetadataV1 } from './reviewArtifactV1.js';

type CoveringReview = Pick<
  ReviewMetadataV1,
  'state' | 'sourceSessionId' | 'sourceSessionSeq'
>;

/**
 * The one coverage decision for "changed files not yet reviewed": a completed Review round covers
 * the Session's turns that ended at or before the Session seq recorded when that round started.
 */
export function listUnreviewedSessionChangedFilesV1<
  TFile extends Pick<SessionChangeSetFile, 'turns'>,
>(
  input: Readonly<{
    sessionId: string;
    changeSet: Readonly<{
      turns: readonly Pick<TurnChangeSet, 'turnId' | 'seqRange'>[];
      files: readonly TFile[];
    }>;
    reviews: readonly CoveringReview[];
  }>,
): TFile[] {
  let covered: number | null = null;
  for (const review of input.reviews) {
    if (
      review.state !== 'completed' ||
      review.sourceSessionId !== input.sessionId ||
      review.sourceSessionSeq == null
    )
      continue;
    covered = Math.max(
      covered ?? review.sourceSessionSeq,
      review.sourceSessionSeq,
    );
  }
  if (covered === null) return [...input.changeSet.files];
  const coveredThrough = covered;
  const endByTurn = new Map(
    input.changeSet.turns.map((turn) => [
      turn.turnId,
      turn.seqRange.endSeqInclusive,
    ]),
  );
  return input.changeSet.files.filter((file) =>
    file.turns.some(
      (turnId) => (endByTurn.get(turnId) ?? Infinity) > coveredThrough,
    ),
  );
}
