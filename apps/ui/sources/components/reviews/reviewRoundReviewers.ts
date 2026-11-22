import type { ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ReviewArtifactV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { readReviewReviewerSlotV1 } from '@happier-dev/protocol/reviews/reviewStart';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveAgentIdFromFlavor, type AgentId } from '@/agents/catalog/catalog';
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
  /** The Agent its recorded name is, for its mark; null for an engine or a model name that is not an Agent. */
  agentId: AgentId | null;
  /** Settled result, open-round execution progress, or unknown for older rounds without individual results. */
  outcome: ReviewRoundReviewerOutcome | null;
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

// One reviewer's ending in one word everywhere it is named (round card, Runs, Activity): "Didn't finish", as the lab
// says it, never the round's "Partial".
const OUTCOME_KEYS = {
  running: 'reviewWalkthrough.collection.stateRunning',
  completed: 'reviewWalkthrough.collection.stateCompleted',
  partial: 'reviewWalkthrough.detail.reviewerDidntFinish',
  failed: 'reviewWalkthrough.collection.stateFailed',
  cancelled: 'reviewWalkthrough.collection.stateCancelled',
} as const satisfies Record<ReviewRoundReviewerOutcome, string>;

export function reviewRoundReviewerOutcomeLabel(outcome: ReviewRoundReviewerOutcome): string {
  return t(OUTCOME_KEYS[outcome]);
}

type NamedRound = Pick<ReviewRound, 'reviewerIds' | 'reviewerDisplayNames'>;

/** The name a round recorded for a reviewer, read as an Agent when it is one ("claude" is Claude, with its mark). */
function recordedReviewer(round: NamedRound, reviewerId: string): Readonly<{ base: string | null; agentId: AgentId | null }> {
  const recorded = round.reviewerDisplayNames?.[reviewerId] ?? null;
  const agentId = recorded ? resolveAgentIdFromFlavor(recorded) : null;
  return { base: agentId ? resolveAgentCatalogTitle(agentId) : recorded, agentId };
}

/**
 * A round's reviewer by name and Agent: the Agent's catalog title (or the name the round recorded), else "Reviewer N"
 * by its place in the round. Reviewers that read the same ("Claude" twice) are told apart by their step when the round
 * ran them in different steps ("Claude · step 2"), else by their order ("Claude 2"). The positional id
 * ("step-1-reviewer-1") is an internal key and is never shown.
 */
export function reviewRoundReviewerIdentity(round: NamedRound, reviewerId: string): Readonly<{ name: string; named: boolean; agentId: AgentId | null }> {
  const { base, agentId } = recordedReviewer(round, reviewerId);
  if (!base) {
    const index = round.reviewerIds.indexOf(reviewerId);
    return { name: t('reviewWalkthrough.detail.reviewerRun', { count: index >= 0 ? index + 1 : 1 }), named: false, agentId };
  }
  const namesakes = round.reviewerIds.filter(id => recordedReviewer(round, id).base === base);
  const position = namesakes.indexOf(reviewerId);
  if (namesakes.length < 2 || position < 0) return { name: base, named: true, agentId };
  const steps = namesakes.map(id => readReviewReviewerSlotV1(id)?.stepIndex);
  const byStep = steps.every(step => step !== undefined) && new Set(steps).size === steps.length;
  return { agentId, named: true, name: byStep
    ? t('reviewWalkthrough.detail.reviewerInStep', { name: base, step: steps[position]! + 1 })
    : t('reviewWalkthrough.detail.reviewerOrdinal', { name: base, count: position + 1 }) };
}

export function reviewRoundReviewerName(round: NamedRound, reviewerId: string): string {
  return reviewRoundReviewerIdentity(round, reviewerId).name;
}

/** How many reviewer rows the round's Runs draws: its settled results, or its started reviewer runs while it runs. */
export function reviewRoundReviewerRowCount(
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerOutcomes' | 'runs'>,
): number {
  if (round.state === 'running') return round.runs.filter(run => run.kind === 'execution').length;
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
  round: Pick<ReviewRound, 'state' | 'reviewerIds' | 'reviewerDisplayNames' | 'reviewerOutcomes' | 'runs'>,
  reads: ReadonlyMap<string, ReviewRoundReviewerRead> | undefined,
): readonly ReviewRoundReviewer[] {
  if (round.state !== 'running') {
    if (round.reviewerOutcomes === undefined) return round.reviewerIds.map(reviewerId => ({
      reviewerId, ...reviewRoundReviewerIdentity(round, reviewerId), outcome: null, findingsCount: null, run: null,
    }));
    // A settled result keeps its own recorded name and facts; a continued execution's later state never overrides them.
    const named = { reviewerIds: round.reviewerOutcomes.map(reviewer => reviewer.reviewerId), reviewerDisplayNames: {
      ...round.reviewerDisplayNames, ...Object.fromEntries(round.reviewerOutcomes.flatMap(reviewer =>
        reviewer.displayName ? [[reviewer.reviewerId, reviewer.displayName]] : [])) } };
    return round.reviewerOutcomes.map(reviewer => ({
      reviewerId: reviewer.reviewerId, ...reviewRoundReviewerIdentity(named, reviewer.reviewerId),
      outcome: reviewer.outcome, runId: reviewer.runId, startedAt: reviewer.startedAt, finishedAt: reviewer.finishedAt,
      findingsCount: null, run: null,
    }));
  }
  return round.reviewerIds.map((reviewerId, index) => {
    const reference = round.runs[index];
    const read = reference?.kind === 'execution' ? reads?.get(reference.runId) ?? null : null;
    const status = read?.run?.status ?? null;
    const ended: ReviewRoundReviewerOutcome | null = status === null || status === 'running' ? null
      : status === 'succeeded' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    return { reviewerId, ...reviewRoundReviewerIdentity(round, reviewerId), outcome: ended ?? 'running',
      runId: reference?.runId, startedAt: read?.run?.startedAtMs, finishedAt: read?.run?.finishedAtMs,
      findingsCount: read?.findingsCount ?? null, run: read?.run ?? null };
  });
}

/** A reviewer the round names as not having finished (partial, failed or stopped): it can be retried. Unknown is not unfinished. */
export function isReviewRoundReviewerUnfinished(reviewer: Pick<ReviewRoundReviewer, 'outcome'>): boolean {
  return reviewer.outcome !== null && reviewer.outcome !== 'running' && reviewer.outcome !== 'completed';
}
