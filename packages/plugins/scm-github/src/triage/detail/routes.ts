import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { GITHUB_MAX_PAGE_SIZE_V1 } from '../types.js';

/**
 * The route templates behind the four GitHub detail planes.
 *
 * Every detail URL in this vertical is built here and nowhere else, from a route
 * this source already validated and an entry number it already proved is a
 * positive decimal. A plane never receives a provider-supplied URL to request:
 * GitHub's `Link` header is validated as "the same request with only `page`
 * advanced" (`scan/link.ts`), and only that page NUMBER crosses back out, so the
 * next request is rebuilt here from the same template rather than carried in
 * panel state.
 *
 * The page sizes are per-plane on purpose. They are not one shared policy: a
 * timeline row is a few short fields, a changed-file row is a path plus counts,
 * and a comment row carries a body an order of magnitude larger. Sizing them
 * together would either starve the cheap planes or make one comment page the
 * heaviest value this source can emit.
 */

/** The largest page GitHub accepts on any of these collections. */
export const GITHUB_MAX_DETAIL_PAGE_SIZE_V1 = GITHUB_MAX_PAGE_SIZE_V1;

/** One page of timeline events. Rows are small, so the page is generous. */
export const GITHUB_TIMELINE_PAGE_SIZE_V1 = 50;

/**
 * One page of changed files, at GitHub's maximum.
 *
 * It is the maximum because the ceiling arithmetic depends on it: 30 pages of
 * 100 is exactly the 3,000 files GitHub will ever return, so the walk reaches
 * its documented end in the fewest possible requests.
 */
export const GITHUB_CHANGED_FILES_PAGE_SIZE_V1 = GITHUB_MAX_DETAIL_PAGE_SIZE_V1;

/**
 * One page of issue comments.
 *
 * GitHub's own default, kept because a comment row carries a body: a hundred of
 * them is the largest value any plane here could emit, for content a reader
 * scrolls through a screen at a time.
 */

/**
 * GitHub's documented changed-file ceiling.
 *
 * `verify-github-sentry.md` G1: *"Responses include a maximum of 3000 files."*
 * Paging harder does not reach file 3,001, and the Compare endpoint is worse
 * (300 files, first page only), so it is not used as a fallback anywhere in this
 * vertical. Reaching this number is a rendered known-incomplete state, never a
 * silent cap.
 */
export const GITHUB_CHANGED_FILES_CEILING_V1 = 3_000;

/** Positive decimal, matching the identity rule the rest of this source uses. */
const ENTRY_NUMBER_PATTERN = /^[1-9][0-9]*$/u;

export type GithubDetailPageRequestV1 = Readonly<{
  route: GithubRepositoryRouteV1;
  /** The native item number, as it appears in the local ref. */
  entryNumber: string;
  perPage: number;
  /** 1-indexed, as GitHub's own pagination is. */
  page: number;
}>;

function assertEntryNumber(entryNumber: string): void {
  if (!ENTRY_NUMBER_PATTERN.test(entryNumber)) {
    throw new Error('github_detail_entry_number_invalid');
  }
}

function assertPageGeometry(perPage: number, page: number): void {
  if (
    !Number.isSafeInteger(perPage)
    || perPage < 1
    || perPage > GITHUB_MAX_DETAIL_PAGE_SIZE_V1
    || !Number.isSafeInteger(page)
    || page < 1
  ) {
    throw new Error('github_detail_page_geometry_invalid');
  }
}

function pagedUrl(
  segments: readonly string[],
  input: Readonly<{ perPage: number; page: number }>,
): string {
  const parameters = new URLSearchParams();
  parameters.set('per_page', String(input.perPage));
  parameters.set('page', String(input.page));
  return `${buildGithubApiUrl(segments)}?${parameters.toString()}`;
}

/**
 * `GET /repos/{owner}/{repo}/issues/{number}/timeline`.
 *
 * The timeline is an ISSUE route for both declared kinds: GitHub numbers pull
 * requests and issues in one sequence per repository, and the timeline of a pull
 * request is served from the issue path. Reading it from `pulls/{number}` would
 * be a 404 on every entry.
 */
export function buildGithubTimelineUrl(input: GithubDetailPageRequestV1): string {
  assertEntryNumber(input.entryNumber);
  assertPageGeometry(input.perPage, input.page);
  return pagedUrl(
    ['repos', input.route.owner, input.route.name, 'issues', input.entryNumber, 'timeline'],
    input,
  );
}

/** `GET /repos/{owner}/{repo}/pulls/{number}/files`. */
export function buildGithubChangedFilesUrl(input: GithubDetailPageRequestV1): string {
  assertEntryNumber(input.entryNumber);
  assertPageGeometry(input.perPage, input.page);
  return pagedUrl(
    ['repos', input.route.owner, input.route.name, 'pulls', input.entryNumber, 'files'],
    input,
  );
}

/**
 * `GET /repos/{owner}/{repo}/pulls/{number}`.
 *
 * The checks plane's first read. Its only purpose is the CURRENT head revision:
 * check runs and commit statuses are keyed by commit, so reading them against a
 * remembered revision would answer for a commit the pull request has moved past
 * and present it as the current state.
 */
export function buildGithubPullRequestUrl(input: Readonly<{
  route: GithubRepositoryRouteV1;
  entryNumber: string;
}>): string {
  assertEntryNumber(input.entryNumber);
  return buildGithubApiUrl(['repos', input.route.owner, input.route.name, 'pulls', input.entryNumber]);
}

/** Reads the `page` a validated follow-up URL advances to. */
export function readGithubValidatedPageNumber(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const page = Number(parsed.searchParams.get('page'));
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}
