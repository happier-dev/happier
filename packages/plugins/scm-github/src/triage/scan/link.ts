import type { TriageListSortV1 } from '@happier-dev/triage-protocol/v1';
import { parseForgeLinkHeader, readForgeLinkHeaderValue } from '@happier-dev/triage-sources/runtime';

import { GITHUB_API_ORIGIN } from '../../observations/githubProviderContracts.js';

import { GITHUB_MAX_PAGE_SIZE_V1 } from '../types.js';

import { GITHUB_SEARCH_ISSUES_PATH } from './query.js';

/**
 * GitHub's `Link` header is the ONLY next-page proof this walk accepts. GitHub's REST
 * best practices require following the returned URL rather than constructing pagination
 * queries, so a validated next URL is followed UNCHANGED — the source never extracts a
 * page number and rebuilds, shrinks, or offsets it.
 *
 * There is no `limit + 1` sentinel row here; that mechanism does not exist on this API.
 *
 * The RFC 8288 grammar is shared with the other forges that paginate that way and comes
 * from `@happier-dev/triage-sources`. What stays here is GitHub's own validation: a
 * next URL is followed only when it is the SAME request with only `page` advanced.
 */

export type GithubValidatedNextPageV1 = Readonly<{ url: string; page: number }>;

/**
 * Validated means: exact `https://api.github.com` origin with no credentials or
 * fragment, the `/search/issues` path, a positive `page`, `per_page` still this
 * lane's issued geometry inside `1..100`, and the frozen lane query, sort, order
 * and advanced-search parameters unchanged.
 *
 * A malformed, cross-origin, or query-changing Link is a typed failure — never a URL to
 * follow and never state to serialize.
 */
export function validateGithubSearchNextUrl(
  candidate: string,
  expected: Readonly<{ laneQuery: string; perPage: number; sort?: TriageListSortV1 }>,
): GithubValidatedNextPageV1 | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.origin !== GITHUB_API_ORIGIN) return null;
  if (url.username || url.password || url.hash) return null;
  if (url.pathname !== GITHUB_SEARCH_ISSUES_PATH) return null;

  const parameters = url.searchParams;
  if (parameters.get('q') !== expected.laneQuery) return null;
  if (parameters.get('sort') !== (expected.sort?.field ?? 'updated')) return null;
  if (parameters.get('order') !== (expected.sort?.direction ?? 'desc')) return null;
  if (parameters.get('advanced_search') !== 'true') return null;

  const perPage = Number(parameters.get('per_page'));
  if (
    !Number.isSafeInteger(perPage)
    || perPage !== expected.perPage
    || perPage < 1
    || perPage > GITHUB_MAX_PAGE_SIZE_V1
  ) {
    return null;
  }
  const page = Number(parameters.get('page'));
  if (!Number.isSafeInteger(page) || page < 1) return null;

  return Object.freeze({ url: url.toString(), page });
}

/**
 * The general follow-up-page rule for GitHub's other paginated collections (check runs,
 * commit statuses, reviews, requested reviewers): the returned URL must be the SAME
 * request with only `page` advanced. GitHub may replace /repos/{owner}/{name}
 * with /repositories/{id}; only the caller's admitted immutable id proves that
 * alias. A different origin, resource, page size, or filter is still refused.
 */
export function validateGithubFollowUpPageUrl(
  candidate: string,
  requestedUrl: string,
  expectedRepositoryId?: string | null,
  pagination: 'page' | 'cursor' = 'page',
): string | null {
  let next: URL;
  let requested: URL;
  try {
    next = new URL(candidate);
    requested = new URL(requestedUrl);
  } catch {
    return null;
  }
  if (next.origin !== GITHUB_API_ORIGIN || next.origin !== requested.origin) return null;
  if (next.username || next.password || next.hash) return null;
  if (next.pathname !== requested.pathname) {
    const resource = /^\/repos\/[^/]+\/[^/]+(\/.*)$/u.exec(requested.pathname)?.[1];
    if (typeof expectedRepositoryId !== 'string' || !/^[1-9][0-9]*$/u.test(expectedRepositoryId)
      || resource === undefined || next.pathname !== `/repositories/${expectedRepositoryId}${resource}`) return null;
  }

  if (pagination === 'page' || !next.searchParams.has('before') && !next.searchParams.has('after')) {
    const page = Number(next.searchParams.get('page'));
    if (!Number.isSafeInteger(page) || page < 1) return null;
    const requestedPageText = requested.searchParams.get('page');
    const requestedPage = requestedPageText === null ? 1 : Number(requestedPageText);
    if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || page <= requestedPage) return null;
  } else {
    const before = next.searchParams.get('before');
    const after = next.searchParams.get('after');
    if ((before === null) === (after === null) || (before ?? after) === '') return null;
    if (before === requested.searchParams.get('before') && after === requested.searchParams.get('after')) return null;
  }

  const comparable = (url: URL): string => {
    const parameters = new URLSearchParams(url.searchParams);
    parameters.delete('page');
    if (pagination === 'cursor') { parameters.delete('before'); parameters.delete('after'); }
    parameters.sort();
    return parameters.toString();
  };
  return comparable(next) === comparable(requested) ? next.toString() : null;
}

/** Alert collections support GitHub's opaque cursor links as well as page links. */
export function validateGithubCursorFollowUpUrl(candidate: string, requestedUrl: string, expectedRepositoryId?: string | null): string | null {
  return validateGithubFollowUpPageUrl(candidate, requestedUrl, expectedRepositoryId, 'cursor');
}

export function readValidatedGithubCursorFollowUpPage(headers: Readonly<Record<string, string>>, requestedUrl: string, expectedRepositoryId?: string | null): Readonly<{ kind: 'ended' }> | Readonly<{ kind: 'next'; url: string }> | Readonly<{ kind: 'invalid' }> {
  return readValidatedGithubFollowUpPage(headers, requestedUrl, expectedRepositoryId, 'cursor');
}

export function readValidatedGithubFollowUpPage(
  headers: Readonly<Record<string, string>>,
  requestedUrl: string,
  expectedRepositoryId?: string | null,
  pagination: 'page' | 'cursor' = 'page',
): Readonly<{ kind: 'ended' }> | Readonly<{ kind: 'next'; url: string }>
  | Readonly<{ kind: 'invalid' }> {
  const parsed = parseForgeLinkHeader(readForgeLinkHeaderValue(headers));
  if (parsed.kind === 'malformed') return Object.freeze({ kind: 'invalid' });
  if (parsed.kind === 'absent') return Object.freeze({ kind: 'ended' });
  const next = parsed.links.next;
  if (next === undefined) return Object.freeze({ kind: 'ended' });
  const validated = validateGithubFollowUpPageUrl(next, requestedUrl, expectedRepositoryId, pagination);
  return validated === null
    ? Object.freeze({ kind: 'invalid' })
    : Object.freeze({ kind: 'next', url: validated });
}

/** Reads the validated `rel="next"` for this lane, or `null` when the walk has ended. */
export function readValidatedGithubNextPage(
  headers: Readonly<Record<string, string>>,
  requestedUrl: string,
  expected: Readonly<{ laneQuery: string; perPage: number; sort?: TriageListSortV1 }>,
): Readonly<{ kind: 'ended' }> | Readonly<{ kind: 'next'; next: GithubValidatedNextPageV1 }>
  | Readonly<{ kind: 'invalid' }> {
  const parsed = parseForgeLinkHeader(readForgeLinkHeaderValue(headers));
  if (parsed.kind === 'malformed') return Object.freeze({ kind: 'invalid' });
  if (parsed.kind === 'absent') return Object.freeze({ kind: 'ended' });
  const next = parsed.links.next;
  if (next === undefined) return Object.freeze({ kind: 'ended' });
  const validated = validateGithubSearchNextUrl(next, expected);
  const requested = validateGithubSearchNextUrl(requestedUrl, expected);
  return validated === null || requested === null || validated.page <= requested.page
    ? Object.freeze({ kind: 'invalid' })
    : Object.freeze({ kind: 'next', next: validated });
}
