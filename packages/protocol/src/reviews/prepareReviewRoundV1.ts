import type { ScmComparison } from '../scm/comparison.js';
import type { ScmComparisonCaptureInput } from '../scm/diffSummary.js';
import { RpcError } from '../rpc/errors.js';
import type { ReviewRecordPortV1, ReviewRoundComparisonCaptureV1, ReviewSourceKindV1 } from './reviewArtifactV1.js';
import type { ReviewPrepareRoundInputV1, ReviewPreparedRoundV1 } from './reviewRoundActionsV1.js';
import { reviewReviewerIdsForStartV1 } from './reviewStart.js';

/** One round/comparison preparation owner for workflow replay and native continuation. */
export async function prepareReviewRoundV1(input: ReviewPrepareRoundInputV1, deps: Readonly<{
  reviewRecords: Pick<ReviewRecordPortV1, 'start'>;
  captureComparison: (input: ScmComparisonCaptureInput) => Promise<ScmComparison>;
  cwd?: string;
  comparisonTarget?: ReviewRoundComparisonCaptureV1['target'];
  sourceKind?: ReviewSourceKindV1;
  startedAt: number;
  signal?: AbortSignal;
}>): Promise<ReviewPreparedRoundV1> {
  let comparison = input.comparison;
  let comparisonCapture = input.comparisonCapture;
  const isNewRound = input.previousRoundContext !== undefined && input.previousRoundContext !== null;
  if ((!comparison && input.reviewInput.comparisonId) || (isNewRound && input.reviewInput.scope !== 'repository')) {
    const cwd = input.comparisonCapture?.cwd ?? input.reviewInput.cwd ?? comparison?.repository.rootPath ?? deps.cwd;
    if (!cwd) throw new RpcError('workspace_unavailable', 'workspace_unavailable');
    const source = input.comparisonCapture?.source ?? comparison?.source;
    if (!source) throw new RpcError('Review comparison capture requires the original source selector', 'invalid_parameters');
    const { comparisonId: retainedCaptureId, ...captureOptions } = input.comparisonCapture ?? {};
    const comparisonId = isNewRound ? undefined : input.reviewInput.comparisonId ?? retainedCaptureId;
    comparisonCapture = { ...captureOptions, cwd, source,
      ...(comparisonId ? { comparisonId } : {}),
    };
    comparison = await deps.captureComparison(comparisonCapture);
  }
  const { projection: _projection, ...retainedCaptureInput } = comparisonCapture ?? {};
  const reviewRound = isNewRound ? await deps.reviewRecords.start({
    reviewId: input.reviewRound.reviewId, title: 'Code review',
    subjectKind: comparison ? 'comparison' : 'repository', sourceKind: deps.sourceKind ?? 'workflow',
    reviewerIds: reviewReviewerIdsForStartV1(input.reviewInput),
    ...(comparison ? { comparisonId: comparison.id } : {}),
    ...(comparison && comparisonCapture && deps.comparisonTarget ? { comparisonCapture: {
      target: deps.comparisonTarget, input: { ...retainedCaptureInput,
        cwd: comparisonCapture.cwd, source: comparisonCapture.source, comparisonId: comparison.id },
    } } : {}),
    startedAt: deps.startedAt, newRound: true, signal: deps.signal,
  }) : input.reviewRound;
  return { reviewRound, ...(comparison ? { comparisonId: comparison.id, comparison } : {}) };
}
