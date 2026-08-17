/**
 * GitLab's private query lanes, and the closed involvement vocabulary they map to.
 *
 * A lane id is provider-private control flow. It is resolved to `matched`,
 * `completeNoMatch` or `unavailable` here, and only the canonical involvement fact
 * crosses out of this package. An unavailable lane never becomes an empty success:
 * a lane that could not run is not a lane that found nothing.
 *
 * Three facts GitLab keeps distinct, and this module keeps distinct too:
 * reviewer *assignment* (`scope=reviews_for_me`), an *approval*
 * (`approved_by_ids[]`), and review *activity* (which GitLab exposes no list lane
 * for at all).
 */

import type { GitlabInvolvementFact, GitlabKindId, GitlabRowFact } from '../types.js';

export const GITLAB_LANE_IDS = [
  'authored',
  'assigned',
  'review-requested',
  'reviewed',
  'mentioned',
  'subscribed',
] as const;
export type GitlabLaneId = (typeof GITLAB_LANE_IDS)[number];

export type GitlabLaneRequest = Readonly<{
  laneId: GitlabLaneId;
  kindId: GitlabKindId;
  path: string;
  query: readonly (readonly [string, string])[];
  involvement: GitlabInvolvementFact;
  /** A bounded native row fact this lane proves, beyond the canonical involvement. */
  nativeRowFact?: GitlabRowFact;
}>;

export type GitlabUnavailableLane = Readonly<{
  laneId: GitlabLaneId;
  kindId: GitlabKindId;
  reason: string;
}>;

export type GitlabScanLanes = Readonly<{
  requests: readonly GitlabLaneRequest[];
  unavailable: readonly GitlabUnavailableLane[];
}>;

export const GITLAB_APPROVED_ROW_FACT: GitlabRowFact = Object.freeze({
  id: 'gitlab/approved',
  importance: 'secondary',
  value: Object.freeze({ kind: 'status', label: 'Approved', tone: 'success' }),
} as const);

export type GitlabLaneSelection = Readonly<{
  kindId: GitlabKindId;
  /**
   * The authenticated account's numeric GitLab user id, when the invocation observed
   * one. `approved_by_ids[]` needs it; nothing else does.
   */
  viewerUserId: number | null;
}>;

/**
 * Builds the lanes for one kind. Every lane GitLab does not offer is returned as an
 * explicit unavailable lane with its reason, so scan health can lower truthfully.
 */
export function buildGitlabScanLanes(selection: GitlabLaneSelection): GitlabScanLanes {
  const requests: GitlabLaneRequest[] = [];
  const unavailable: GitlabUnavailableLane[] = [];
  const kindId = selection.kindId;
  const path = kindId === 'merge-request' ? '/merge_requests' : '/issues';

  requests.push({
    laneId: 'authored',
    kindId,
    path,
    query: [['scope', 'created_by_me']],
    involvement: 'author',
  });
  requests.push({
    laneId: 'assigned',
    kindId,
    path,
    query: [['scope', 'assigned_to_me']],
    involvement: 'assignee',
  });

  if (kindId === 'merge-request') {
    // GitLab's documented current-account reviewer-assignment lane. It says the
    // viewer was asked to review, never that the viewer reviewed.
    requests.push({
      laneId: 'review-requested',
      kindId,
      path,
      query: [['scope', 'reviews_for_me']],
      involvement: 'reviewRequested',
    });

    if (selection.viewerUserId !== null) {
      // One id, not a compound "all reviewers" query. It discovers approvals only:
      // not comment-only review activity, not an unapproval, not participation.
      requests.push({
        laneId: 'reviewed',
        kindId,
        path,
        query: [['scope', 'all'], ['approved_by_ids[]', String(selection.viewerUserId)]],
        involvement: 'participating',
        nativeRowFact: GITLAB_APPROVED_ROW_FACT,
      });
    } else {
      unavailable.push({
        laneId: 'reviewed',
        kindId,
        reason: 'gitlab-viewer-id-unavailable',
      });
    }
  } else {
    unavailable.push({
      laneId: 'review-requested',
      kindId,
      reason: 'gitlab-issue-review-lane-unavailable',
    });
    unavailable.push({
      laneId: 'reviewed',
      kindId,
      reason: 'gitlab-issue-review-lane-unavailable',
    });
  }

  // GitLab documents no mention filter. `scope=all&search=@me` is a text search, and
  // answering a mention query with a text search is a confidently wrong answer.
  unavailable.push({
    laneId: 'mentioned',
    kindId,
    reason: kindId === 'merge-request'
      ? 'gitlab-mentioned-lane-unavailable'
      : 'gitlab-issue-mentioned-lane-unavailable',
  });

  // Subscription is an item-level fact when GitLab returns one. Walking `scope=all`
  // and filtering locally would be an expensive, still-moving claim of completeness.
  unavailable.push({
    laneId: 'subscribed',
    kindId,
    reason: kindId === 'merge-request'
      ? 'gitlab-subscribed-lane-unavailable'
      : 'gitlab-issue-subscribed-lane-unavailable',
  });

  return { requests, unavailable };
}

/**
 * The bounded reason names one GitLab walk can carry, in the fixed precedence
 * `sources/SCM.md` §2.8b declares.
 *
 * The first three are **sticky**: once any page of a walk observes one, every later
 * page of that same walk still reports it, because the honest arm is otherwise
 * unreachable — page one skips an undecodable row, pages two and three walk clean
 * lanes, and the settling `complete` would tell the user the inbox is whole.
 * `projection-budget` and `continuation-unavailable` are deliberately NOT sticky: the
 * first is a per-call page shape the continuation itself resolves, and the second ends
 * the walk in the call it appears.
 *
 * `continuation-unavailable` outranks everything: it is the only reason that says this
 * walk stopped before its lanes ended, which is a stronger caveat than anything
 * observed inside the part that did run.
 */
export const GITLAB_STICKY_WALK_REASONS = [
  'undecodable-items',
  'lane-unresolved',
  'lane-unavailable',
] as const;
export type GitlabStickyWalkReason = (typeof GITLAB_STICKY_WALK_REASONS)[number];

export const GITLAB_WALK_REASON_PRECEDENCE = [
  'continuation-unavailable',
  ...GITLAB_STICKY_WALK_REASONS,
  'projection-budget',
] as const;
export type GitlabWalkReason = (typeof GITLAB_WALK_REASON_PRECEDENCE)[number];

export function isGitlabStickyWalkReason(value: unknown): value is GitlabStickyWalkReason {
  return typeof value === 'string'
    && (GITLAB_STICKY_WALK_REASONS as readonly string[]).includes(value);
}

export type GitlabScanHealth =
  | Readonly<{ kind: 'walkFinished' }>
  | Readonly<{ kind: 'partial'; reason: GitlabWalkReason }>;

/**
 * Resolves the one reason a page reports out of everything the walk observed.
 *
 * `walkFinished` is the ceiling and is reachable only with an empty reason set: the
 * lanes are selected universes and the walk cannot see its own size past GitLab's
 * 10,000-record header cut-off, so even a clean walk claims nothing about the
 * collection and no scan ever concludes absence.
 */
export function projectGitlabScanHealth(
  reasons: ReadonlySet<GitlabWalkReason>,
): GitlabScanHealth {
  for (const reason of GITLAB_WALK_REASON_PRECEDENCE) {
    if (reasons.has(reason)) return { kind: 'partial', reason };
  }
  return { kind: 'walkFinished' };
}

/**
 * The item-level subscription fact, mapped only when GitLab actually returned it.
 * A missing `subscribed` key is permission-scoped or endpoint-scoped omission, not
 * evidence that the viewer is unsubscribed.
 */
export function readGitlabSubscribedFact(
  row: Readonly<Record<string, unknown>>,
): GitlabInvolvementFact | null {
  return row.subscribed === true ? 'subscribed' : null;
}

/**
 * The involvement an authoritative single-item read can prove.
 *
 * A `get` is reached by route, not by a query lane, so there is no lane fact to
 * map. What the item itself carries — who wrote it, who it is assigned to, who
 * was asked to review it — is real evidence and is mapped here through the same
 * canonical vocabulary. Nothing is inferred from an unknown viewer: with no
 * observed viewer username the result is empty rather than guessed.
 */
export function deriveGitlabItemInvolvement(input: Readonly<{
  viewerUsername: string | null;
  author: string | null;
  assignees: readonly string[];
  reviewers: readonly string[];
  subscribed: boolean;
}>): readonly GitlabInvolvementFact[] {
  const facts: GitlabInvolvementFact[] = [];
  const viewer = input.viewerUsername;
  if (viewer !== null) {
    if (input.author === viewer) facts.push('author');
    if (input.assignees.includes(viewer)) facts.push('assignee');
    if (input.reviewers.includes(viewer)) facts.push('reviewRequested');
  }
  if (input.subscribed) facts.push('subscribed');
  return facts;
}
