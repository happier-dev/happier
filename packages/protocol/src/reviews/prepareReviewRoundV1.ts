import { ScmComparisonSourceSchema, type ScmComparison, type ScmComparisonSource } from '../scm/comparison.js';
import type { ScmComparisonCaptureInput } from '../scm/diffSummary.js';
import { RpcError } from '../rpc/errors.js';
import type { ReviewArtifactV1, ReviewRecordPortV1, ReviewRoundComparisonCaptureV1, ReviewRoundStartV1, ReviewSourceKindV1 } from './reviewArtifactV1.js';
import type { ReviewPrepareRoundInputV1, ReviewPreparedRoundV1 } from './reviewRoundActionsV1.js';
import { reviewReviewerDisplayNamesForStartV1, reviewReviewerIdsForStartV1, type ReviewBase, type ReviewStartInput } from './reviewStart.js';
import { readRecord } from '../inputs/inputRecords.js';
import type { ScmWorkingSnapshot } from '../scm/workingSnapshot.js';
import { resolveCapturedReviewScmScopeV1, type ReviewScmScopeBaseRefV1 } from './scope.js';

/** Review base inference is shared by Action capture and direct Run preparation. */
export function resolveReviewBaseRefV1(base: ReviewBase,
  snapshot?: Pick<ScmWorkingSnapshot, 'branch' | 'repo'>): ReviewScmScopeBaseRefV1 {
  if (base.kind === 'branch') return { source: 'explicit', ref: base.baseBranch };
  if (base.kind === 'commit') return { source: 'explicit', ref: base.baseCommit };
  const upstream = snapshot?.branch.upstream?.trim();
  if (upstream) return { source: 'branch_upstream', ref: upstream };
  const defaultBranch = snapshot?.repo.defaultRef?.trim() || snapshot?.repo.defaultBranch?.trim();
  if (defaultBranch) return { source: 'default_branch', ref: defaultBranch };
  return { source: 'unavailable', ref: null };
}

/** Explicit comparisons retain their selector; committed Review captures branch history. */
export async function resolveReviewComparisonSourceV1(input: Pick<ReviewStartInput, 'changeType' | 'base'>
  & Partial<Pick<ReviewStartInput, 'scope' | 'comparisonId' | 'scmPullRequestReviewScope' | 'source' | 'headRef'>>,
  readSnapshot?: () => Promise<Pick<ScmWorkingSnapshot, 'branch' | 'repo'> | undefined>): Promise<ScmComparisonSource | undefined> {
  if (input.scope === 'repository') return undefined;
  if (input.source !== undefined) return ScmComparisonSourceSchema.parse(input.source);
  if (input.comparisonId || input.scmPullRequestReviewScope) return undefined;
  if (input.changeType === 'committed') {
    const explicit = resolveReviewBaseRefV1(input.base);
    const base = explicit.ref ? explicit : resolveReviewBaseRefV1(input.base, await readSnapshot?.());
    if (!base.ref) throw new RpcError('Select a base for the committed Review; the repository has no upstream or default branch.', 'invalid_parameters');
    return { kind: 'branch', head: input.headRef ?? 'HEAD', base: base.ref };
  }
  return { kind: 'workingTree', area: input.changeType === 'all' ? 'both' : 'pending' };
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

/** A retry of chosen reviewers narrows the next round to those admitted roster slots. */
function readRetriedReviewerIds(previousRoundContext: unknown, roster: readonly string[]): string[] | undefined {
  const requested = readRecord(previousRoundContext).reviewerIds;
  if (requested === undefined) return undefined;
  if (!Array.isArray(requested) || requested.length === 0
    || requested.some(id => typeof id !== 'string' || !roster.includes(id))) {
    throw new RpcError('Retry names a reviewer outside this Review', 'invalid_parameters');
  }
  return roster.filter(id => requested.includes(id));
}

type ReviewRoundPreparationInputV1 = Omit<ReviewPrepareRoundInputV1, 'reviewRound'> & (
  | Pick<ReviewPrepareRoundInputV1, 'reviewRound'>
  | Readonly<{ reviewStart: Omit<ReviewRoundStartV1, 'title' | 'startedAt' | 'signal'> }>
);

/** The admitted comparison names a new Review; later rounds retain its stored title. */
export function preparedReviewTitleV1(input: ReviewStartInput, comparison?: ScmComparison, captureSource?: ScmComparisonSource): string {
  const pullRequest = input.scmPullRequestReviewScope?.pullRequest;
  const knownTitle = readRecord(pullRequest).title;
  if (typeof knownTitle === 'string' && knownTitle.trim()) return knownTitle.trim();
  const source = comparison?.source ?? captureSource;
  const capturedTitle = comparison?.pullRequest?.title?.trim();
  if (source?.kind === 'pullRequest' && capturedTitle) return capturedTitle;
  switch (source?.kind) {
    case 'pullRequest': return `${source.locator.repository}#${source.locator.number}`;
    case 'branch': return source.head;
    case 'commit': return source.commit;
    case 'revisionRange': return `${source.baseOid}..${source.headOid}`;
    case 'workingTree': return 'Working tree changes';
    case 'session': return 'Session changes';
    case 'turnCheckpoint': return 'Turn changes';
  }
  const reference = readRecord(pullRequest);
  if (typeof reference.number === 'number') return `Pull request #${reference.number}`;
  if (typeof reference.headBranch === 'string') return reference.headBranch;
  return input.headRef ?? input.cwd ?? 'Repository';
}

/** One initial admission and round/comparison preparation owner for every reviewer path. */
export async function prepareReviewRoundV1(input: ReviewRoundPreparationInputV1, deps: Readonly<{
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
  const isInitialAdmission = 'reviewStart' in input;
  const isNewRound = !isInitialAdmission && input.previousRoundContext !== undefined && input.previousRoundContext !== null;
  if ((!isInitialAdmission && !comparison && input.reviewInput.comparisonId) || (isNewRound && input.reviewInput.scope !== 'repository')) {
    const cwd = input.comparisonCapture?.cwd ?? input.reviewInput.cwd ?? comparison?.repository.rootPath ?? deps.cwd;
    if (!cwd) throw new RpcError('workspace_unavailable', 'workspace_unavailable');
    const source = input.comparisonCapture?.source ?? comparison?.source ?? await resolveReviewComparisonSourceV1(input.reviewInput);
    if (!source) throw new RpcError('Review comparison capture requires the original source selector', 'invalid_parameters');
    const { comparisonId: retainedCaptureId, ...captureOptions } = input.comparisonCapture ?? {};
    const comparisonId = isNewRound ? undefined : input.reviewInput.comparisonId ?? retainedCaptureId;
    comparisonCapture = { ...captureOptions, cwd, source,
      ...(comparisonId ? { comparisonId } : {}),
    };
    comparison = await deps.captureComparison(comparisonCapture);
  }
  const scmReviewScope = comparison ? resolveCapturedReviewScmScopeV1(comparison, input.reviewInput) : undefined;
  if (scmReviewScope?.status === 'unsupported') {
    const diagnostic = scmReviewScope.diagnostics[0];
    throw new RpcError(diagnostic?.message ?? 'The selected review scope is unavailable.', diagnostic?.code ?? 'scm_status_unavailable');
  }
  const { projection: _projection, ...retainedCaptureInput } = comparisonCapture ?? {};
  const roster = reviewReviewerIdsForStartV1(input.reviewInput);
  const retried = isNewRound ? readRetriedReviewerIds(input.previousRoundContext, roster) : undefined;
  const title = preparedReviewTitleV1(input.reviewInput, comparison, comparisonCapture?.source);
  const reviewRound = 'reviewStart' in input ? await deps.reviewRecords.start({ ...input.reviewStart,
    title,
    startedAt: deps.startedAt, signal: deps.signal,
  }) : isNewRound ? await deps.reviewRecords.start({
    reviewId: input.reviewRound.reviewId, title,
    subjectKind: comparison ? 'comparison' : 'repository', sourceKind: deps.sourceKind ?? 'workflow',
    reviewerIds: retried ?? roster,
    reviewerDisplayNames: reviewReviewerDisplayNamesForStartV1(input.reviewInput),
    ...(comparison ? { comparisonId: comparison.id } : {}),
    ...(comparison && comparisonCapture && deps.comparisonTarget ? { comparisonCapture: {
      target: deps.comparisonTarget, input: { ...retainedCaptureInput,
        cwd: comparisonCapture.cwd, source: comparison.source, comparisonId: comparison.id },
    } } : {}),
    startedAt: deps.startedAt, newRound: true, signal: deps.signal,
  }) : input.reviewRound;
  const skipped = retried ? roster.filter(id => !retried.includes(id)) : [];
  return { reviewRound, ...(scmReviewScope ? { scmReviewScope } : {}), newRoundCostConsent: isNewRound ? readRecord(input.previousRoundContext).costConsent === true : null,
    ...(skipped.length ? { skippedReviewers: Object.fromEntries(skipped.map(id => [id, true as const])) } : {}),
    ...(comparison ? { comparisonId: comparison.id, comparison } : {}),
    ...(input.reviewInput.inlineThreshold === undefined ? {} : { inlineThreshold: input.reviewInput.inlineThreshold }) };
}
