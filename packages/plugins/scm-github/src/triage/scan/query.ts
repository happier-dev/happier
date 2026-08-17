import { GITHUB_API_ORIGIN } from '../../observations/githubProviderContracts.js';

import { GITHUB_MAX_PAGE_SIZE_V1, type GithubTriageInvolvementV1 } from '../types.js';

/**
 * Lane query construction. One request per involvement lane, never a union query,
 * because the response cannot say which lane matched.
 */

export type GithubScanLaneIdV1 =
  | 'authored'
  | 'review-requested'
  | 'reviewed'
  | 'assigned'
  | 'mentioned';

/**
 * Bounded round-robin order: attention-first. Authored work cannot starve
 * review-requested, assigned or mentioned work, and every non-ended lane is attempted
 * within one five-request cycle.
 */
export const GITHUB_SCAN_LANE_ORDER_V1: readonly GithubScanLaneIdV1[] = Object.freeze([
  'review-requested',
  'assigned',
  'mentioned',
  'reviewed',
  'authored',
]);

/**
 * `review-requested:` is deliberately the TEAM-INCLUSIVE qualifier. GitHub documents
 * that a review request addressed to a team the viewer belongs to also matches it,
 * while `user-review-requested:` is direct-only — choosing that one silently empties
 * the inbox of every user whose organization requests reviews by team.
 */
const LANE_QUALIFIERS: Readonly<Record<GithubScanLaneIdV1, string>> = Object.freeze({
  authored: 'author:@me',
  'review-requested': 'review-requested:@me',
  reviewed: 'reviewed-by:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
});

/** Native lane evidence maps to the closed canonical vocabulary before serialization. */
const LANE_INVOLVEMENT: Readonly<Record<GithubScanLaneIdV1, GithubTriageInvolvementV1>> =
  Object.freeze({
    authored: 'author',
    'review-requested': 'reviewRequested',
    reviewed: 'participating',
    assigned: 'assignee',
    mentioned: 'mentioned',
  });

export function mapGithubLaneToInvolvement(
  laneId: GithubScanLaneIdV1,
): GithubTriageInvolvementV1 {
  return LANE_INVOLVEMENT[laneId];
}

/**
 * Base qualifiers are always sent EXPLICITLY: a source may report only what it asked
 * for, and GitHub's search defaults are not evidence about what was filtered.
 *
 * No `updated:`/`since` qualifier is ever sent: it filters on a mutating field and
 * would imply a change watermark this source cannot honour.
 */
export function buildGithubLaneQuery(input: Readonly<{
  laneId: GithubScanLaneIdV1;
  repositoryKey: string | null;
}>): string {
  const qualifiers = ['is:open', 'archived:false'];
  if (input.repositoryKey !== null) qualifiers.push(`repo:${input.repositoryKey}`);
  qualifiers.push(LANE_QUALIFIERS[input.laneId]);
  return qualifiers.join(' ');
}

export const GITHUB_SEARCH_ISSUES_PATH = '/search/issues';

export type GithubLaneRequestGeometryV1 = Readonly<{
  laneQuery: string;
  perPage: number;
  page: number;
}>;

export function buildGithubLaneSearchUrl(geometry: GithubLaneRequestGeometryV1): string {
  if (
    !Number.isSafeInteger(geometry.perPage)
    || geometry.perPage < 1
    || geometry.perPage > GITHUB_MAX_PAGE_SIZE_V1
  ) {
    throw new RangeError('GitHub search page size must be between 1 and 100');
  }
  if (!Number.isSafeInteger(geometry.page) || geometry.page < 1) {
    throw new RangeError('GitHub search page must be a positive integer');
  }
  const url = new URL(`${GITHUB_API_ORIGIN}${GITHUB_SEARCH_ISSUES_PATH}`);
  url.searchParams.set('q', geometry.laneQuery);
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(geometry.perPage));
  url.searchParams.set('page', String(geometry.page));
  url.searchParams.set('advanced_search', 'true');
  return url.toString();
}
