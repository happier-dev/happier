import type { TriageRowFactV1 } from '@happier-dev/triage-protocol/v1';

import type {
  GithubProjectedReviewRequestRowV1,
  GithubProjectedReviewerRowV1,
} from '../../triage/detail/projection.js';
import type {
  GithubFeedbackCommentV1,
  GithubFeedbackRequestV1,
  GithubFeedbackReviewV1,
  GithubFeedbackThreadV1,
} from '../../triage/feedback.js';
import {
  buildGithubStateRowFactsV1,
  type GithubChecksRowStateV1,
  type GithubReviewDecisionV1,
} from '../../triage/mapping/facts.js';
import { toTriageFacts } from '../../triage/mapping/protocol.js';

/**
 * The GitHub `Feedback` plane's projection.
 *
 * `Feedback` is named that, and not `Reviews`, because it unifies finding
 * sources that are not all reviews: what people said about the pull request,
 * and what GitHub itself says is wrong with it. A reviewer triaging a pull
 * request asks one question — what is being said, and what is failing — and a
 * product that answers it across four screens has not answered it.
 *
 * Everything here is a projection of values the surface ALREADY holds: the
 * conversation its own panel read, the authoritative review and check reads,
 * and the mergeability fact the applied observation arrived with. Nothing in
 * this module issues, schedules or implies a provider request.
 *
 * Line-anchored review threads remain their own resource even though this plane
 * renders them beside issue comments. Their cursor, replies and resolved state
 * are projected directly; none is inferred from review history or timeline rows.
 *
 * Review history, outstanding requests and the review decision come from three
 * explicit GraphQL facts and from nowhere else. The event timeline mentions
 * reviews too, and deriving them from it was
 * cheaper by one request — but it is a different, weaker answer: the events are
 * paged, so who has approved depended on how far the reader had scrolled; a
 * review GitHub later dismissed still counted; and an outstanding request
 * addressed to somebody who never appeared in the loaded pages was invisible.
 * Two owners for "who has signed off" is one owner too many, so the timeline is
 * no longer read for it here.
 *
 * The live review decision and checks replace those two snapshot facts before anything
 * renders. Snapshot mergeability stays: this detail surface has no live
 * mergeability read, so dropping it would turn a fact GitHub did publish into
 * an invented absence. `checks.ts` already derives its row-fact state over
 * every observation it read, and this plane folds it in through the SHARED fact
 * constructors the list row uses, so "Changes requested" is one sentence in
 * this product rather than two.
 */

export type GithubFeedbackToneV1 = Extract<TriageRowFactV1['value'], { kind: 'status' }>['tone'];

/**
 * One finding, in the arms this build can actually prove.
 */
export type GithubFeedbackFindingV1 =
  | Readonly<{
    resource: 'comment';
    kind: 'remark';
    id: string;
    /** `null` when GitHub returned no creation time; never defaulted to now. */
    atMs: number | null;
    author: string | null;
    body: string;
    webUrl: string | null;
    truncated: boolean;
  }>
  | Readonly<{
    resource: 'review';
    kind: 'remark';
    id: string;
    atMs: number | null;
    author: string | null;
    body: string;
    state: string;
    webUrl: string | null;
    truncated: boolean;
  }>
  | Readonly<{
    resource: 'thread';
    kind: 'thread';
    id: string;
    atMs: number | null;
    path: string | null;
    line: number | null;
    isResolved: boolean;
    replies: readonly GithubFeedbackCommentV1[];
    previousRepliesCursor: string | null;
  }>
  | Readonly<{
    resource: 'state';
    kind: 'check' | 'conflict';
    id: string;
    atMs: number | null;
    /** GitHub's own words, already bounded by the observation's projection. */
    label: string;
    tone: GithubFeedbackToneV1;
  }>;

/**
 * Whether this pull request is approved — or whether nobody could say.
 *
 * `unresolved` is a third answer, not a missing one. GitHub's authoritative
 * review decision includes an arm that depends on branch-protection rules the
 * REST reads behind this surface never see, so an absent decision means the
 * question was not answered. Rendering it as "not approved" would state a fact
 * about a rule this build never read.
 */
export type GithubFeedbackReviewSummaryV1 =
  | Readonly<{ kind: 'unresolved' }>
  | Readonly<{ kind: 'decided'; label: string; tone: GithubFeedbackToneV1 }>;

/**
 * One person or team who has actually reviewed, at their latest review.
 *
 * `state` is GitHub's own word — `approved`, `changes_requested`, `commented`,
 * `dismissed` — kept as the provider fact it is. Re-spelling it into a private
 * vocabulary here would make one word mean two things across the four forges;
 * the renderer owns how it is said to a reader.
 */
export type GithubFeedbackReviewerV1 = GithubProjectedReviewerRowV1;

/** One review GitHub still records as awaited. */
export type GithubFeedbackReviewRequestV1 = GithubProjectedReviewRequestRowV1;

/**
 * The two review-people questions, kept apart.
 *
 * A reviewer list built from requests loses everybody who already reviewed, and
 * one built from reviews hides a request still nobody has answered. They are
 * never unioned: a person who reviewed is history, and an unanswered request is
 * work outstanding.
 */
export type GithubFeedbackReviewPeopleV1 = Readonly<{
  reviewed: readonly GithubFeedbackReviewerV1[];
  requested: readonly GithubFeedbackReviewRequestV1[];
}>;

/**
 * The settled answer of the authoritative review read.
 *
 * `null` while that read has not settled — which is NOT an empty review list.
 * Rendering "nobody has reviewed this" over a read still in flight is the one
 * answer this plane must never give by accident.
 */
const NO_REVIEW_PEOPLE: GithubFeedbackReviewPeopleV1 = Object.freeze({
  reviewed: Object.freeze([]),
  requested: Object.freeze([]),
});

export type GithubFeedbackViewV1 = Readonly<{
  review: GithubFeedbackReviewSummaryV1;
  people: GithubFeedbackReviewPeopleV1;
  findings: readonly GithubFeedbackFindingV1[];
}>;

export type GithubFeedbackInputV1 = Readonly<{
  /** The applied observation's own row facts. */
  facts: readonly TriageRowFactV1[];
  /** When the applied observation was taken; the time its state findings have. */
  observedAtMs: number;
  comments: readonly GithubFeedbackCommentV1[];
  historicalReviews: readonly GithubFeedbackReviewV1[];
  threads: readonly GithubFeedbackThreadV1[];
  /**
   * The settled authoritative review read, or `null` while it has not settled.
   *
   * Required rather than optional for the same reason the timeline once was: an
   * omitted member would silently produce "nobody has reviewed this".
   */
  /** GitHub's authoritative pull-request reviewDecision field. */
  reviewDecision: GithubReviewDecisionV1 | null;
  /** GitHub's outstanding reviewRequests connection, kept separate from history. */
  requests: readonly GithubFeedbackRequestV1[];
  /**
   * The check-suite row state the checks plane read, or `null` when that plane
   * has not settled or could not answer.
   *
   * It is the state `checks.ts` derived over EVERY observation it read, not a
   * rollup recomputed from the bounded rows a panel lists.
   */
  checks: GithubChecksRowStateV1 | null;
}>;

/** The fact ids whose adverse value is a finding, and the arm each becomes. */
const STATE_FINDING_KINDS: Readonly<Record<string, 'check' | 'conflict' | undefined>> =
  Object.freeze({
    'github/checks': 'check',
    'github/mergeability': 'conflict',
  });

const REVIEW_DECISION_FACT_ID = 'github/review-decision';
const CHECKS_FACT_ID = 'github/checks';

/**
 * The applied observation is intentionally not a second authority for the two
 * facts the Feedback panel reads live. Retain mergeability and every other
 * snapshot fact, then install the current answer through the same constructors
 * the list row uses.
 */
function currentFacts(input: GithubFeedbackInputV1): readonly TriageRowFactV1[] {
  const liveFacts = toTriageFacts(buildGithubStateRowFactsV1({
    reviewDecision: input.reviewDecision,
    checks: input.checks,
  })).facts;
  return Object.freeze([
    ...input.facts.filter((fact) =>
      fact.id !== REVIEW_DECISION_FACT_ID && fact.id !== CHECKS_FACT_ID),
    ...liveFacts,
  ]);
}

function statusValue(
  fact: TriageRowFactV1,
): Readonly<{ label: string; tone: GithubFeedbackToneV1 }> | null {
  return fact.value.kind === 'status'
    ? { label: fact.value.value, tone: fact.value.tone }
    : null;
}

function reviewPeople(
  historical: readonly GithubFeedbackReviewV1[],
  requests: readonly GithubFeedbackRequestV1[],
): GithubFeedbackReviewPeopleV1 {
  if (historical.length === 0 && requests.length === 0) return NO_REVIEW_PEOPLE;
  const latestByAuthor = new Map<string, GithubFeedbackReviewV1>();
  for (const review of historical) {
    if (review.author !== null) latestByAuthor.set(review.author, review);
  }
  return Object.freeze({
    reviewed: Object.freeze([...latestByAuthor.entries()].map(([login, review]) => Object.freeze({
      login,
      state: review.state,
      ...(review.submittedAtMs === null ? {} : { submittedAtMs: review.submittedAtMs }),
    }))),
    requested: Object.freeze(requests.map((request) => Object.freeze({ ...request }))),
  });
}

function reviewSummary(facts: readonly TriageRowFactV1[]): GithubFeedbackReviewSummaryV1 {
  for (const fact of facts) {
    if (fact.id !== REVIEW_DECISION_FACT_ID) continue;
    const status = statusValue(fact);
    if (status === null) continue;
    return { kind: 'decided', label: status.label, tone: status.tone };
  }
  return { kind: 'unresolved' };
}

function stateFindings(
  facts: readonly TriageRowFactV1[],
  observedAtMs: number,
): readonly GithubFeedbackFindingV1[] {
  const findings: GithubFeedbackFindingV1[] = [];
  for (const fact of facts) {
    const kind = STATE_FINDING_KINDS[fact.id];
    if (kind === undefined) continue;
    const status = statusValue(fact);
    // Only what the source itself published as adverse. A passing suite, a
    // computing merge and a clean approval are the state this pull request is
    // in, not a list of things wrong with it — and a rule that admitted every
    // state fact would put "All passing" among the findings.
    if (status === null || status.tone !== 'danger') continue;
    findings.push({
      resource: 'state',
      kind,
      id: fact.id,
      atMs: observedAtMs,
      label: status.label,
      tone: status.tone,
    });
  }
  return findings;
}

function remarkFindings(
  comments: readonly GithubFeedbackCommentV1[],
): readonly GithubFeedbackFindingV1[] {
  return comments.map((row) => ({
    resource: 'comment' as const,
    kind: 'remark' as const,
    id: row.id,
    atMs: row.createdAtMs,
    author: row.author,
    body: row.body,
    webUrl: row.url,
    truncated: row.truncated === true,
  }));
}

function reviewFindings(
  reviews: readonly GithubFeedbackReviewV1[],
): readonly GithubFeedbackFindingV1[] {
  return reviews.map((review) => ({
    resource: 'review' as const,
    kind: 'remark' as const,
    id: review.id,
    atMs: review.submittedAtMs,
    author: review.author,
    body: review.body,
    state: review.state,
    webUrl: review.url,
    truncated: review.truncated === true,
  }));
}

function threadFindings(
  threads: readonly GithubFeedbackThreadV1[],
): readonly GithubFeedbackFindingV1[] {
  return threads.map((thread) => ({
    resource: 'thread' as const,
    kind: 'thread' as const,
    id: thread.id,
    atMs: thread.replies[0]?.createdAtMs ?? null,
    path: thread.path,
    line: thread.line,
    isResolved: thread.isResolved,
    replies: thread.replies,
    previousRepliesCursor: thread.previousRepliesCursor,
  }));
}

/**
 * Orders the merged feed.
 *
 * "Ascending id" is a per-resource guarantee and never a cross-resource one, so
 * two independently ordered GitHub resources interleaved by arrival order would
 * be presented as chronological while being wrong. Time decides; `(resource,
 * id)` breaks the tie deterministically. A row GitHub returned without a
 * creation time keeps its place at the end rather than being dropped or dated.
 */
function compareFindings(a: GithubFeedbackFindingV1, b: GithubFeedbackFindingV1): number {
  if (a.atMs === null || b.atMs === null) {
    if (a.atMs !== b.atMs) return a.atMs === null ? 1 : -1;
  } else if (a.atMs !== b.atMs) {
    return a.atMs - b.atMs;
  }
  if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function projectGithubFeedback(input: GithubFeedbackInputV1): GithubFeedbackViewV1 {
  const facts = currentFacts(input);
  const findings = [
    ...remarkFindings(input.comments),
    ...reviewFindings(input.historicalReviews),
    ...threadFindings(input.threads),
    ...stateFindings(facts, input.observedAtMs),
  ].sort(compareFindings);
  return {
    review: reviewSummary(facts),
    people: reviewPeople(input.historicalReviews, input.requests),
    findings: Object.freeze(findings),
  };
}
