import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewArtifactV1, ReviewRoundReviewerOutcomeV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { readReviewReviewerSlotV1 } from '@happier-dev/protocol/reviews/reviewStart';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';

import { normalizeAgentCatalogId, resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
import { presentExecutionRunFailureSummary } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

type ReviewRound = ReviewArtifactV1['rounds'][number];

/** How one reviewer of a round ended, as the page says it beside its name. */
export type ReviewRoundReviewerOutcome =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export type ReviewRoundReviewer = Readonly<{
  reviewerId: string;
  name: string;
  /** The round recorded a name for it; false when `name` is only its place ("Reviewer 2"). */
  named: boolean;
  /** The recorded Agent resolved through its catalog for the mark; null when the Agent is unknown. */
  agentId: AgentId | null;
  /** Settled result, open-round execution progress, or unknown for older rounds without individual results. */
  outcome: ReviewRoundReviewerOutcome | null;
  /** Why it didn't finish, in words ("Usage limit reached"), from its settled reason; null when none was recorded. */
  reason: string | null;
  /** The settled Action refusal, retained for the existing diagnostic disclosure. */
  failure?: ActionExecuteFailure;
  runId?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Findings its run reported, when its Machine answered for it. */
  findingsCount: number | null;
  /** Its run as its Machine last answered (Agent and model), when read. */
  run: ExecutionRunPublicState | null;
}>;

/** One reviewer run's last read, keyed by run id (`useReviewQuestionRuns`). */
export type ReviewRoundReviewerRead = Readonly<{
  run: ExecutionRunPublicState | null;
  findingsCount: number | null;
}>;

// Present the settled coverage unchanged, everywhere this reviewer is named.
const OUTCOME_KEYS = {
  running: 'reviewWalkthrough.collection.stateRunning',
  completed: 'reviewWalkthrough.collection.stateCompleted',
  partial: 'reviewWalkthrough.collection.statePartial',
  failed: 'reviewWalkthrough.collection.stateFailed',
  cancelled: 'reviewWalkthrough.collection.stateCancelled',
} as const satisfies Record<ReviewRoundReviewerOutcome, string>;

export function reviewRoundReviewerOutcomeLabel(outcome: ReviewRoundReviewerOutcome): string {
  return t(OUTCOME_KEYS[outcome]);
}

/** A failed reviewer's typed cause is its status; a partial result keeps its coverage label. */
export function reviewRoundReviewerStateLabel(reviewer: Pick<ReviewRoundReviewer, 'outcome' | 'reason'>): string | null {
  return reviewer.outcome === 'failed' && reviewer.reason ? reviewer.reason
    : reviewer.outcome ? reviewRoundReviewerOutcomeLabel(reviewer.outcome) : null;
}

type NamedRound = Pick<ReviewRound, 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerAgentIds'>;
type ReviewerReason = ReviewRoundReviewerOutcomeV1['reason'];

/**
 * Why a reviewer didn't finish, in words, from its settled reason (P02 887367bc64d): the runtime issue or run error
 * through the run-failure owner's words ("Usage limit reached"), else how its run or its publishing ended. One map for
 * the notice and the Runs row, so a person can tell whether Retry will help.
 */
export function reviewRoundReviewerReasonWords(reason: ReviewerReason | undefined): string | null {
  if (!reason) return null;
  if (reason.errorCode) {
    const message = resolveActionExecutionFailureMessage({ ...reason, ok: false,
      errorCode: reason.errorCode, error: reason.error ?? reason.errorCode }, '');
    if (message) return message;
  }
  const issue = reason.runtimeIssue ? SessionRuntimeIssueV1Schema.safeParse({ v: 1, scope: 'primary_session', status: 'failed',
    occurredAt: 0, source: reason.runtimeIssue.source, code: reason.runtimeIssue.code }).data : undefined;
  const failure = issue || reason.errorCode ? presentExecutionRunFailureSummary({ code: reason.errorCode ?? issue!.code,
    ...(issue ? { runtimeIssueV1: issue } : {}) }) : null;
  if (failure?.summary) return failure.summary;
  if (reason.run === 'launch_failed') return t('reviewWalkthrough.detail.reasonLaunchFailed');
  if (reason.run === 'cancelled') return t('reviewWalkthrough.detail.reasonStopped');
  if (reason.materialization) return t('reviewWalkthrough.detail.reasonFindingsNotSaved');
  if (reason.reviewOutcome === 'partial') return t('reviewWalkthrough.detail.reasonStoppedEarly');
  if (reason.reviewOutcome === 'failed' || reason.reviewOutcome === 'unavailable') return t('reviewWalkthrough.detail.reasonNoResult');
  return null;
}

/**
 * Every reviewer the Review named across its rounds, with the names they recorded: a reviewer keeps one name in every
 * round ("Claude · step 2" in round 1 and in its retry round), so disambiguation reads the whole roster.
 */
export function reviewRosterOf(rounds: readonly Pick<ReviewRound, 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerAgentIds' | 'reviewerOutcomes'>[]): NamedRound {
  const reviewerIds: string[] = [];
  const reviewerDisplayNames: Record<string, string> = {};
  const reviewerAgentIds: Record<string, string> = {};
  for (const round of rounds) {
    for (const id of [...round.reviewerIds, ...(round.reviewerOutcomes ?? []).map(outcome => outcome.reviewerId)]) {
      if (!reviewerIds.includes(id)) reviewerIds.push(id);
    }
    Object.assign(reviewerDisplayNames, round.reviewerDisplayNames,
      Object.fromEntries((round.reviewerOutcomes ?? []).flatMap(outcome => outcome.displayName ? [[outcome.reviewerId, outcome.displayName]] : [])));
    Object.assign(reviewerAgentIds, round.reviewerAgentIds,
      Object.fromEntries((round.reviewerOutcomes ?? []).flatMap(outcome => outcome.agentId ? [[outcome.reviewerId, outcome.agentId]] : [])));
  }
  return { reviewerIds, reviewerDisplayNames, reviewerAgentIds };
}

/** Session titles stay names; their separately recorded Agent owns the mark. Older Agent names still use the catalog. */
function recordedReviewer(round: NamedRound, reviewerId: string): Readonly<{ base: string | null; agentId: AgentId | null }> {
  const recorded = round.reviewerDisplayNames?.[reviewerId] ?? null;
  const recordedAgentId = round.reviewerAgentIds?.[reviewerId];
  const identity = recordedAgentId ?? recorded;
  const agentId = identity ? resolveAgentIdFromFlavor(normalizeAgentCatalogId(identity)) : null;
  const titled = recordedAgentId && recorded && recorded !== recordedAgentId;
  return { base: titled ? recorded : agentId ? resolveAgentCatalogTitle(agentId) : recorded, agentId };
}

/**
 * A round's reviewer by name and Agent: the Agent's catalog title (or the name the round recorded), else "Reviewer N"
 * by its place in the round. Reviewers that read the same ("Claude" twice) are told apart by their step when the round
 * ran them in different steps ("Claude · step 2"), else by their order ("Claude 2"). The positional id
 * ("step-1-reviewer-1") is an internal key and is never shown.
 */
export function reviewRoundReviewerIdentity(round: NamedRound, reviewerId: string,
  roster: NamedRound = round): Readonly<{ name: string; named: boolean; agentId: AgentId | null }> {
  const own = recordedReviewer(round, reviewerId);
  const { base, agentId } = own.base ? own : recordedReviewer(roster, reviewerId);
  if (!base) {
    const index = round.reviewerIds.indexOf(reviewerId);
    return { name: t('reviewWalkthrough.detail.reviewerRun', { count: index >= 0 ? index + 1 : 1 }), named: false, agentId };
  }
  // Namesakes across the whole Review, so a reviewer retried alone in a later round keeps its step.
  const namesakes = roster.reviewerIds.filter(id => recordedReviewer(roster, id).base === base);
  const position = namesakes.indexOf(reviewerId);
  if (namesakes.length < 2 || position < 0) return { name: base, named: true, agentId };
  const steps = namesakes.map(id => readReviewReviewerSlotV1(id)?.stepIndex);
  const byStep = steps.every(step => step !== undefined) && new Set(steps).size === steps.length;
  return { agentId, named: true, name: byStep
    ? t('reviewWalkthrough.detail.reviewerInStep', { name: base, step: steps[position]! + 1 })
    : t('reviewWalkthrough.detail.reviewerOrdinal', { name: base, count: position + 1 }) };
}

export function reviewRoundReviewerName(round: NamedRound, reviewerId: string, roster?: NamedRound): string {
  return reviewRoundReviewerIdentity(round, reviewerId, roster).name;
}

/**
 * The reviewer a round's run belongs to: its settled result's, else its place among the round's reviewer runs (the
 * same pairing the Runs rows use while the round runs). Null when the run is no reviewer's.
 */
export function reviewRoundRunReviewerId(
  round: Pick<ReviewRound, 'reviewerIds' | 'reviewerOutcomes' | 'runs'>, runId: string,
): string | null {
  const settled = round.reviewerOutcomes?.find(outcome => outcome.runId === runId)?.reviewerId;
  if (settled) return settled;
  const index = round.runs.filter(run => run.kind === 'execution').findIndex(run => run.runId === runId);
  return index >= 0 ? round.reviewerIds[index] ?? null : null;
}

/** How many reviewer rows the round's Runs draws: its settled results, or its reviewers while it runs. */
export function reviewRoundReviewerRowCount(
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerOutcomes' | 'runs'>,
): number {
  // A running round lists every reviewer it started, whether or not its own run is referenced yet (U8 R6 RN1).
  if (round.state === 'running') return round.reviewerIds.length;
  return round.reviewerOutcomes?.length ?? round.reviewerIds.length;
}

/** A Changes filter chip's reviewer, by the Agent its comments name ("codex" is Codex), else by its place. */
export function reviewCommentEngineName(engineId: string, index: number): string {
  const agentId = resolveAgentIdFromFlavor(engineId);
  return agentId ? resolveAgentCatalogTitle(agentId) : t('reviewWalkthrough.detail.reviewerRun', { count: index + 1 });
}

/**
 * Settlement owns individual results and timing. Continued executions can outlive a round, so their current state
 * supplies progress only while the round is open. Older settled rounds keep names without inventing individual facts.
 */
export function projectReviewRoundReviewers(
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerAgentIds' | 'reviewerOutcomes' | 'runs'>,
  reads: ReadonlyMap<string, ReviewRoundReviewerRead> | undefined,
  /** The whole Review's roster (`reviewRosterOf`), so names stay the same across rounds; this round alone otherwise. */
  roster?: NamedRound,
): readonly ReviewRoundReviewer[] {
  if (round.state !== 'running') {
    if (round.reviewerOutcomes === undefined) return round.reviewerIds.map(reviewerId => ({
      reviewerId, ...reviewRoundReviewerIdentity(round, reviewerId, roster), outcome: null, reason: null, findingsCount: null, run: null,
    }));
    // A settled result keeps its own recorded name and facts; a continued execution's later state never overrides them.
    const named = reviewRosterOf([{ reviewerIds: round.reviewerOutcomes.map(reviewer => reviewer.reviewerId),
      reviewerDisplayNames: round.reviewerDisplayNames, reviewerAgentIds: round.reviewerAgentIds, reviewerOutcomes: round.reviewerOutcomes }]);
    return round.reviewerOutcomes.map(reviewer => ({
      reviewerId: reviewer.reviewerId, ...reviewRoundReviewerIdentity(named, reviewer.reviewerId, roster ?? named),
      outcome: reviewer.outcome, reason: reviewRoundReviewerReasonWords(reviewer.reason),
      ...(reviewer.reason?.errorCode ? { failure: readActionFailureEnvelope({ ...reviewer.reason, ok: false }) ?? undefined } : {}),
      runId: reviewer.runId, startedAt: reviewer.startedAt, finishedAt: reviewer.finishedAt,
      findingsCount: null, run: null,
    }));
  }
  // Reviewer runs only: a running round may also carry its Workflow run, which is no reviewer's.
  const executions = round.runs.filter(run => run.kind === 'execution');
  return round.reviewerIds.map((reviewerId, index) => {
    const reference = executions[index];
    const read = reference?.kind === 'execution' ? reads?.get(reference.runId) ?? null : null;
    const status = read?.run?.status ?? null;
    const ended: ReviewRoundReviewerOutcome | null = status === null || status === 'running' ? null
      : status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    return { reviewerId, ...reviewRoundReviewerIdentity(round, reviewerId, roster), outcome: ended ?? 'running', reason: null,
      runId: reference?.runId, startedAt: read?.run?.startedAtMs, finishedAt: read?.run?.finishedAtMs,
      findingsCount: read?.findingsCount ?? null, run: read?.run ?? null };
  });
}

/**
 * The reviewers a settled round says didn't finish: those whose result says so, or, in an older one-reviewer round
 * that ended partial or failed with no individual result, its only reviewer (it is the one that didn't finish).
 */
export function reviewRoundUnfinishedReviewers<Reviewer extends Pick<ReviewRoundReviewer, 'outcome'>>(
  round: Pick<ReviewRound, 'state'>, reviewers: readonly Reviewer[],
): readonly Reviewer[] {
  const known = reviewers.filter(isReviewRoundReviewerUnfinished);
  if (known.length > 0) return known;
  return (round.state === 'partial' || round.state === 'failed') && reviewers.length === 1 && reviewers[0]!.outcome === null
    ? reviewers : [];
}

/** A reviewer the round names as not having finished (partial, failed or stopped): it can be retried. Unknown is not unfinished. */
export function isReviewRoundReviewerUnfinished(reviewer: Pick<ReviewRoundReviewer, 'outcome'>): boolean {
  return reviewer.outcome !== null && reviewer.outcome !== 'running' && reviewer.outcome !== 'completed';
}
