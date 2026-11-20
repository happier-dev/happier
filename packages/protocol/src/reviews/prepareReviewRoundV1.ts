import { ScmComparisonSourceSchema, type ScmComparison, type ScmComparisonSource } from '../scm/comparison.js';
import type { ScmComparisonCaptureInput } from '../scm/diffSummary.js';
import { RpcError } from '../rpc/errors.js';
import type { ReviewArtifactV1, ReviewRecordPortV1, ReviewRoundComparisonCaptureV1, ReviewSourceKindV1 } from './reviewArtifactV1.js';
import type { ReviewPrepareRoundInputV1, ReviewPreparedRoundV1 } from './reviewRoundActionsV1.js';
import { reviewReviewerIdsForStartV1, reviewWorkingTreeAreaV1, type ReviewStartInput } from './reviewStart.js';
import { readRecord } from '../inputs/inputRecords.js';

/** An explicit comparison keeps its original selector; ordinary changes select their admitted area. */
export function resolveReviewComparisonSourceV1(input: ReviewStartInput): ScmComparisonSource | undefined {
  if (input.source !== undefined) return ScmComparisonSourceSchema.parse(input.source);
  if (input.scope === 'repository' || input.comparisonId || input.scmPullRequestReviewScope) return undefined;
  return { kind: 'workingTree', area: reviewWorkingTreeAreaV1(input.changeType) };
}

/** A person-only Review repeats its record and evidence without inventing execution. */
export async function prepareReviewHumanRoundV1(review: ReviewArtifactV1, deps: Readonly<{
  reviewRecords: Pick<ReviewRecordPortV1, 'start' | 'settle'>;
  captureComparison: (input: ScmComparisonCaptureInput, target: ReviewRoundComparisonCaptureV1['target']) => Promise<ScmComparison>;
  startedAt: number;
  signal?: AbortSignal;
}>): Promise<ReviewPreparedRoundV1> {
  const previous = review.rounds.at(-1);
  if (!previous || previous.reviewerIds.length > 0 || previous.runs.length > 0
    || previous.comparisonId && !previous.comparisonCapture) throw new RpcError('invalid_parameters', 'invalid_parameters');
  const retained = previous.comparisonCapture;
  let comparison: ScmComparison | undefined;
  if (retained) {
    const { comparisonId: _priorId, ...input } = retained.input;
    comparison = await deps.captureComparison(input, retained.target);
  }
  const reviewRound = await deps.reviewRecords.start({ reviewId: review.reviewId, title: review.title,
    subjectKind: comparison ? 'comparison' : 'repository', sourceKind: 'direct', reviewerIds: [],
    ...(comparison && retained ? { comparisonId: comparison.id, comparisonCapture: { ...retained,
      input: { ...retained.input, source: comparison.source, comparisonId: comparison.id } } } : {}),
    startedAt: deps.startedAt, newRound: true, signal: deps.signal });
  await deps.reviewRecords.settle({ ...reviewRound, outcome: 'completed', finishedAt: deps.startedAt,
    runs: [], signal: deps.signal });
  return { reviewRound, ...(comparison ? { comparisonId: comparison.id, comparison } : {}) };
}

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
    const source = input.comparisonCapture?.source ?? comparison?.source ?? resolveReviewComparisonSourceV1(input.reviewInput);
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
        cwd: comparisonCapture.cwd, source: comparison.source, comparisonId: comparison.id },
    } } : {}),
    startedAt: deps.startedAt, newRound: true, signal: deps.signal,
  }) : input.reviewRound;
  return { reviewRound, newRoundCostConsent: isNewRound ? readRecord(input.previousRoundContext).costConsent === true : null,
    ...(comparison ? { comparisonId: comparison.id, comparison } : {}),
    ...(input.reviewInput.inlineThreshold === undefined ? {} : { inlineThreshold: input.reviewInput.inlineThreshold }) };
}
