import type { BitbucketTriageApiClient } from '../apiClient.js';
import { readBitbucketApiUrl } from '../apiUrl.js';
import { walkBitbucketCollection } from '../collection.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';

import {
  BITBUCKET_DETAIL_BOUNDS_V1,
  projectBitbucketActivityRows,
  projectBitbucketBuildRollup,
  projectBitbucketCommentRows,
  projectBitbucketStatusRows,
  type BitbucketBuildRollupV1,
  type BitbucketPageProjectionV1,
  type BitbucketProjectedActivityRowV1,
  type BitbucketProjectedCommentRowV1,
  type BitbucketProjectedStatusRowV1,
} from './projection.js';
import {
  BITBUCKET_ACTIVITY_PAGE_LENGTH_V1,
  BITBUCKET_COMMENTS_PAGE_LENGTH_V1,
  BITBUCKET_STATUSES_PAGE_LENGTH_V1,
  buildBitbucketActivityUrl,
  buildBitbucketCommentsUrl,
  buildBitbucketStatusesUrl,
  type BitbucketDetailRouteInputV1,
} from './routes.js';

/**
 * The bounded single-page reads behind the Bitbucket Cloud detail planes.
 *
 * They reuse the package's one collection walker rather than adding a second
 * pagination decision-maker: `maxPages: 1` makes it read exactly the page the
 * reader asked for and hand back Bitbucket's own opaque `next`. Stopping there
 * is this caller's contract rather than an anomaly, so it passes no page-ceiling
 * code and the frontier comes back clean.
 *
 * The next page is Bitbucket's `next`, followed byte-for-byte and admitted
 * against the exact Cloud API base. Atlassian documents it as an opaque location
 * clients must not construct, and admitting it is what keeps the materialized
 * credential from reaching a location an attacker influenced.
 */

export type BitbucketDetailReadResultV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/** Where one settled page left the walk. */
export type BitbucketWalkPositionV1 = Readonly<{
  /** Bitbucket's own next-page URL, or `null` when the collection ended. */
  nextUrl: string | null;
  /** True when this page is the whole collection. */
  complete: boolean;
}>;

export type BitbucketDetailPageV1<TRow> =
  BitbucketPageProjectionV1<TRow> & BitbucketWalkPositionV1;

export type BitbucketDetailReadDependenciesV1 = Readonly<{
  client: BitbucketTriageApiClient;
  signal?: AbortSignal;
}>;

/**
 * The URL one page of a walk requests: the first page this source builds, or the
 * exact `next` Bitbucket issued for the previous one.
 */
export type BitbucketDetailPagePositionV1 =
  | Readonly<{ kind: 'first' }>
  | Readonly<{ kind: 'continued'; nextUrl: string }>;

const REQUEST_INVALID = createBitbucketFailure(
  'unsupportedContract',
  'detail-request-invalid',
);

async function readDetailPage<TRow>(
  dependencies: BitbucketDetailReadDependenciesV1,
  input: Readonly<{
    position: BitbucketDetailPagePositionV1;
    buildFirstUrl: () => string;
    pageLength: number;
    project: (values: readonly unknown[]) => BitbucketPageProjectionV1<TRow>;
  }>,
): Promise<BitbucketDetailReadResultV1<BitbucketDetailPageV1<TRow>>> {
  let firstUrl: string;
  try {
    firstUrl = input.buildFirstUrl();
  } catch {
    return { ok: false, failure: REQUEST_INVALID };
  }
  // A continuation is re-admitted against the Cloud API base here as well as on
  // the way in: a token is untrusted input in both directions.
  const resumeUrl = input.position.kind === 'continued'
    ? readBitbucketApiUrl(input.position.nextUrl)
    : null;
  if (input.position.kind === 'continued' && resumeUrl === null) {
    return { ok: false, failure: REQUEST_INVALID };
  }

  const outcome = await walkBitbucketCollection<unknown>({
    client: dependencies.client,
    url: firstUrl,
    // The projector is the boundary; the walker's per-row decode stays a
    // pass-through so a row this projection cannot understand is COUNTED as
    // omitted rather than silently dropped before it is seen.
    decode: (raw) => raw,
    pageLength: input.pageLength,
    maxPages: 1,
    ...(resumeUrl === null ? {} : { resumeUrl }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  if (!outcome.ok) return { ok: false, failure: outcome.failure };
  // A page that failed mid-read carries its failure rather than its rows: half a
  // page with no next link would read as a finished collection.
  if (outcome.failure !== undefined) return { ok: false, failure: outcome.failure };

  const projected = input.project(outcome.items);
  return {
    ok: true,
    value: Object.freeze({
      ...projected,
      nextUrl: outcome.nextUrl,
      complete: outcome.complete,
    }),
  };
}

/* ------------------------------------------------------------------ activity */

export async function readBitbucketActivityPage(
  input: Readonly<{
    route: BitbucketDetailRouteInputV1;
    position: BitbucketDetailPagePositionV1;
  }>,
  dependencies: BitbucketDetailReadDependenciesV1,
): Promise<BitbucketDetailReadResultV1<BitbucketDetailPageV1<BitbucketProjectedActivityRowV1>>> {
  return readDetailPage(dependencies, {
    position: input.position,
    buildFirstUrl: () => buildBitbucketActivityUrl(input.route),
    pageLength: BITBUCKET_ACTIVITY_PAGE_LENGTH_V1,
    project: (values) => projectBitbucketActivityRows(values, BITBUCKET_DETAIL_BOUNDS_V1),
  });
}

/* -------------------------------------------------------------------- builds */

export type BitbucketBuildsReadV1 =
  BitbucketDetailPageV1<BitbucketProjectedStatusRowV1> & Readonly<{
    /** `null` whenever this page is not the whole collection — never zeroes. */
    rollup: BitbucketBuildRollupV1 | null;
  }>;

export async function readBitbucketBuildsPage(
  input: Readonly<{
    route: BitbucketDetailRouteInputV1;
    position: BitbucketDetailPagePositionV1;
  }>,
  dependencies: BitbucketDetailReadDependenciesV1,
): Promise<BitbucketDetailReadResultV1<BitbucketBuildsReadV1>> {
  const page = await readDetailPage(dependencies, {
    position: input.position,
    buildFirstUrl: () => buildBitbucketStatusesUrl(input.route),
    pageLength: BITBUCKET_STATUSES_PAGE_LENGTH_V1,
    project: (values) => projectBitbucketStatusRows(values, BITBUCKET_DETAIL_BOUNDS_V1),
  });
  if (!page.ok) return page;
  return {
    ok: true,
    value: Object.freeze({
      ...page.value,
      rollup: projectBitbucketBuildRollup({
        rows: page.value.rows,
        complete: page.value.complete,
      }),
    }),
  };
}

/* ------------------------------------------------------------------ comments */

export async function readBitbucketCommentsPage(
  input: Readonly<{
    route: BitbucketDetailRouteInputV1;
    position: BitbucketDetailPagePositionV1;
  }>,
  dependencies: BitbucketDetailReadDependenciesV1,
): Promise<BitbucketDetailReadResultV1<BitbucketDetailPageV1<BitbucketProjectedCommentRowV1>>> {
  return readDetailPage(dependencies, {
    position: input.position,
    buildFirstUrl: () => buildBitbucketCommentsUrl(input.route),
    pageLength: BITBUCKET_COMMENTS_PAGE_LENGTH_V1,
    project: (values) => projectBitbucketCommentRows(values, BITBUCKET_DETAIL_BOUNDS_V1),
  });
}
