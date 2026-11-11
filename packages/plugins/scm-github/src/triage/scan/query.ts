import { GITHUB_API_ORIGIN } from '../../observations/githubProviderContracts.js';
import type { TriageListSortV1 } from '@happier-dev/triage-protocol/v1';

import { GITHUB_MAX_PAGE_SIZE_V1, type GithubTriageInvolvementV1 } from '../types.js';

const GITHUB_NATIVE_SORT_FIELDS = Object.freeze({ updated: 'updated', created: 'created' } as const);
export const GITHUB_TRIAGE_SORT_FIELDS_V1 = Object.freeze(
  Object.keys(GITHUB_NATIVE_SORT_FIELDS) as (keyof typeof GITHUB_NATIVE_SORT_FIELDS)[],
);
export function supportsGithubTriageSortField(field: TriageListSortV1['field']): boolean {
  return Object.prototype.hasOwnProperty.call(GITHUB_NATIVE_SORT_FIELDS, field);
}

/**
 * Lane query construction. One request per involvement lane, never a union query,
 * because the response cannot say which lane matched.
 */

export type GithubScanLaneIdV1 = (typeof GITHUB_SCAN_LANE_ORDER_V1)[number];

/**
 * Bounded round-robin order: attention-first. Authored work cannot starve
 * review-requested, assigned or mentioned work, and every non-ended lane is attempted
 * within one five-request cycle.
 */
export const GITHUB_SCAN_LANE_ORDER_V1 = Object.freeze([
  'review-requested',
  'assigned',
  'mentioned',
  'reviewed',
  'authored',
] as const);

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
  repositoryKeys: readonly string[] | null;
  completedSinceMs?: number;
  query?: string;
}>): string {
  const qualifiers = [input.completedSinceMs === undefined ? 'is:open'
    : `(is:open OR (is:issue is:closed closed:>=${new Date(input.completedSinceMs).toISOString()}))`, 'archived:false'];
  const repositories = input.repositoryKeys ?? [];
  if (repositories.length > 0) qualifiers.push(repositories.length === 1 ? `repo:${repositories[0]}`
    : `(${repositories.map(key => `repo:${key}`).join(' OR ')})`);
  qualifiers.push(LANE_QUALIFIERS[input.laneId]);
  // Text terms stay literals: a typed OR/repo: qualifier must not widen the
  // configured repository or involvement selection.
  const terms = input.query?.trim().split(/\s+/u).filter(Boolean) ?? [];
  qualifiers.push(...terms.map(term => JSON.stringify(term)));
  return qualifiers.join(' ');
}

/** GitHub allows five Boolean operators, excluding qualifiers from its text limit.
 * The completed-issues expression above already consumes one OR.
 * https://docs.github.com/en/rest/search/search#limitations-on-query-length
 */
export function groupGithubScanRepositories(repositoryKeys: readonly string[], completedSinceMs?: number): readonly (readonly string[])[] {
  const groupSize = 5 - (completedSinceMs === undefined ? 0 : 1) + 1;
  const groups: string[][] = [];
  for (let index = 0; index < repositoryKeys.length; index += groupSize) groups.push(repositoryKeys.slice(index, index + groupSize));
  return groups;
}

export const GITHUB_SEARCH_ISSUES_PATH = '/search/issues';

export type GithubLaneRequestGeometryV1 = Readonly<{
  laneQuery: string;
  perPage: number;
  page: number;
  sort?: TriageListSortV1;
}>;

function mapGithubSort(sort: TriageListSortV1 | undefined): Readonly<{ field: 'updated' | 'created'; direction: 'asc' | 'desc' }> | null {
  if (sort === undefined) return { field: 'updated', direction: 'desc' };
  const fields: Readonly<Partial<Record<TriageListSortV1['field'], 'updated' | 'created'>>> = GITHUB_NATIVE_SORT_FIELDS;
  const field = fields[sort.field];
  return field === undefined ? null : { field, direction: sort.direction };
}

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
  const providerSort = mapGithubSort(geometry.sort);
  if (providerSort !== null) {
    url.searchParams.set('sort', providerSort.field);
    url.searchParams.set('order', providerSort.direction);
  }
  url.searchParams.set('per_page', String(geometry.perPage));
  url.searchParams.set('page', String(geometry.page));
  url.searchParams.set('advanced_search', 'true');
  return url.toString();
}
