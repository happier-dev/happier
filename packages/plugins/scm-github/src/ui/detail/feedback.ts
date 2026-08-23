import type { TriageRowFactV1 } from '@happier-dev/triage-protocol/v1';

import type {
  GithubProjectedCommentRowV1,
  GithubProjectedTimelineRowV1,
} from '../../triage/detail/projection.js';

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
 * conversation its own panel read, and the state facts the applied observation
 * arrived with. Nothing in this module issues, schedules or implies a provider
 * request, so the plane costs the same rate budget as the conversation alone.
 *
 * What this build cannot see, it says rather than implies. GitHub serves
 * line-anchored review threads and their resolved state through a separate
 * resource this build does not read, and a panel that quietly omitted them
 * would present a partial conversation as the whole one. The renderer states
 * the omission; this module simply never fabricates those facts.
 *
 * Approvals are the one review fact this build CAN prove without a new read,
 * because the event walk already carries them: a review is a timeline event
 * naming its author, GitHub's own state word and its instant, and a review
 * request is a timeline event naming the user or team asked. Today both are
 * rendered as ordinary timeline lines and nothing else, so a reviewer looking
 * for "has anyone signed off" has to read the whole history to find out. This
 * module reads those same rows a second time in memory rather than reading
 * GitHub a second time over the wire.
 */

export type GithubFeedbackToneV1 = Extract<TriageRowFactV1['value'], { kind: 'status' }>['tone'];

/**
 * One finding, in the arms this build can actually prove.
 *
 * `thread` is deliberately absent rather than empty: an arm that could only
 * ever be empty is a promise the reader would read as an answer.
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
export type GithubFeedbackReviewerV1 = Readonly<{
  /** The event's provider identity, so a re-read keeps the row stable. */
  id: string;
  /** `null` when GitHub returned the review without an author. */
  login: string | null;
  state: string | null;
  atMs: number | null;
  webUrl: string | null;
}>;

/** One review GitHub recorded as asked for and that these events never answer. */
export type GithubFeedbackReviewRequestV1 = Readonly<{
  id: string;
  /** The requested user login or team name, exactly as GitHub named it. */
  subject: string;
  atMs: number | null;
  webUrl: string | null;
}>;

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

export type GithubFeedbackViewV1 = Readonly<{
  review: GithubFeedbackReviewSummaryV1;
  people: GithubFeedbackReviewPeopleV1;
  findings: readonly GithubFeedbackFindingV1[];
}>;

export type GithubFeedbackInputV1 = Readonly<{
  facts: readonly TriageRowFactV1[];
  /** When the applied observation was taken; the only time a state finding has. */
  observedAtMs: number;
  comments: readonly GithubProjectedCommentRowV1[];
  /**
   * The events the timeline walk has already read, in the order it read them.
   *
   * Required rather than optional: an omitted timeline would silently produce
   * "nobody has reviewed this", which is the one answer this plane must never
   * give by accident.
   */
  timeline: readonly GithubProjectedTimelineRowV1[];
}>;

/** The fact ids whose adverse value is a finding, and the arm each becomes. */
const STATE_FINDING_KINDS: Readonly<Record<string, 'check' | 'conflict' | undefined>> =
  Object.freeze({
    'github/checks': 'check',
    'github/mergeability': 'conflict',
  });

const REVIEW_DECISION_FACT_ID = 'github/review-decision';

function statusValue(
  fact: TriageRowFactV1,
): Readonly<{ label: string; tone: GithubFeedbackToneV1 }> | null {
  return fact.value.kind === 'status'
    ? { label: fact.value.value, tone: fact.value.tone }
    : null;
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
  comments: readonly GithubProjectedCommentRowV1[],
): readonly GithubFeedbackFindingV1[] {
  return comments.map((row) => ({
    resource: 'comment' as const,
    kind: 'remark' as const,
    id: row.id,
    atMs: row.atMs ?? null,
    author: row.author ?? null,
    body: row.body,
    webUrl: row.webUrl ?? null,
    truncated: row.truncated === true,
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

/**
 * Chronological order, computed here rather than assumed of the caller.
 *
 * The fold below is sequential — a removal after a request means something a
 * removal before it does not — so an ordering the caller merely happens to
 * supply would make this derivation depend on a page-arrival accident. An event
 * with no readable instant sorts last rather than to the epoch, where it would
 * claim to predate every dated event.
 */
function chronological(
  rows: readonly GithubProjectedTimelineRowV1[],
): readonly GithubProjectedTimelineRowV1[] {
  return [...rows].sort((left, right) => {
    const leftAt = left.atMs ?? null;
    const rightAt = right.atMs ?? null;
    if (leftAt === null || rightAt === null) {
      if (leftAt !== rightAt) return leftAt === null ? 1 : -1;
    } else if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Who has reviewed, and who is still being waited on.
 *
 * Both come from the events already read, so both are only ever as complete as
 * that walk. The renderer states that basis; this function never presents a
 * partially-read history as a settled one.
 *
 * One bound is worth naming: a request addressed to a TEAM is answered on
 * GitHub when any member reviews, and the member's login is not the team's
 * name, so such a request stays listed here. Guessing team membership from a
 * review author would invent a fact this build never read.
 */
function reviewPeople(
  timeline: readonly GithubProjectedTimelineRowV1[],
): GithubFeedbackReviewPeopleV1 {
  const reviewed = new Map<string, GithubFeedbackReviewerV1>();
  const requested = new Map<string, GithubFeedbackReviewRequestV1>();

  for (const row of chronological(timeline)) {
    if (row.kind === 'reviewed') {
      const login = row.actor ?? null;
      // Keyed by the reviewer, so a reviewer who asked for changes and then
      // approved is APPROVED rather than two rows, one of which blocks a pull
      // request they already signed off. A review GitHub returned without an
      // author keeps its own key: two unattributable reviews are two reviews,
      // not one person named nobody who reviewed twice.
      reviewed.set(login ?? `\u0000${row.id}`, Object.freeze({
        id: row.id,
        login,
        state: row.summary ?? null,
        atMs: row.atMs ?? null,
        webUrl: row.webUrl ?? null,
      }));
      // Submitting a review answers that person's request. GitHub emits a
      // removal event only for a request somebody withdrew, so a request
      // fulfilled by its reviewer would otherwise be waited on forever.
      if (login !== null) requested.delete(login);
      continue;
    }
    if (row.kind !== 'reviewRequested' && row.kind !== 'reviewRequestRemoved') continue;
    const subject = row.summary;
    // A request GitHub returned naming neither a user nor a team cannot be
    // rendered as somebody being waited on. The row keeps its place in the
    // Timeline panel; it is only unnameable here.
    if (subject === undefined) continue;
    if (row.kind === 'reviewRequested') {
      requested.set(subject, Object.freeze({
        id: row.id,
        subject,
        atMs: row.atMs ?? null,
        webUrl: row.webUrl ?? null,
      }));
      continue;
    }
    requested.delete(subject);
  }

  return Object.freeze({
    reviewed: Object.freeze([...reviewed.values()]),
    requested: Object.freeze([...requested.values()]),
  });
}

export function projectGithubFeedback(input: GithubFeedbackInputV1): GithubFeedbackViewV1 {
  const findings = [
    ...remarkFindings(input.comments),
    ...stateFindings(input.facts, input.observedAtMs),
  ].sort(compareFindings);
  return {
    review: reviewSummary(input.facts),
    people: reviewPeople(input.timeline),
    findings: Object.freeze(findings),
  };
}
