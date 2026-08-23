import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from '../../observations/githubApiClient.js';
import { readGithubPullRequestChecks, type GithubChecksSurfaceV1 } from '../checks.js';
import {
  readGithubPullRequestReviewers,
  type GithubReviewersSurfaceV1,
} from '../reviews.js';
import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from '../errors.js';
import type { GithubRepositoryRouteV1 } from '../locator.js';
import { decodeGithubPullRequestBody } from '../mapping/entry.js';
import { readValidatedGithubFollowUpPage } from '../scan/link.js';
import type { GithubTriageFailureV1 } from '../types.js';

import {
  GITHUB_DETAIL_BOUNDS_V1,
  projectGithubChangedFileRows,
  projectGithubCommentRows,
  projectGithubTimelineRows,
  type GithubPageProjectionV1,
  type GithubProjectedChangedFileRowV1,
  type GithubProjectedCommentRowV1,
  type GithubProjectedTimelineRowV1,
} from './projection.js';
import {
  GITHUB_CHANGED_FILES_CEILING_V1,
  buildGithubChangedFilesUrl,
  buildGithubIssueCommentsUrl,
  buildGithubPullRequestUrl,
  buildGithubTimelineUrl,
  readGithubValidatedPageNumber,
  type GithubDetailPageRequestV1,
} from './routes.js';

/**
 * The bounded reads behind the four GitHub detail planes.
 *
 * Each one issues exactly one request per page, decodes it, projects it at the
 * boundary, and states where the walk stands. None of them retains a credential,
 * caches, or holds state between invocations: a mounted panel's position lives
 * in a source-minted continuation and nowhere else.
 *
 * `Link` is the only next-page proof accepted, and it is accepted only after
 * `scan/link.ts` proves the advertised URL is the SAME request with only `page`
 * advanced. What crosses back out is that page NUMBER, so the following request
 * is rebuilt from this source's own route template — a URL provably identical to
 * the one GitHub advertised, without a provider-controlled URL ever reaching a
 * panel.
 *
 * Three walk outcomes are kept distinct because they are three different
 * answers, and the panels render them differently:
 *
 * - the collection ran out — the walk ended, and nothing is claimed about
 *   completeness beyond what was read;
 * - GitHub advertised a next page this source will not follow — the rows already
 *   read are kept and the walk is reported `incomplete: 'pagination'`;
 * - the changed-file walk reached GitHub's documented 3,000-file ceiling — the
 *   rows are kept and the walk is reported `incomplete: 'ceiling'`.
 */

export type GithubDetailReadResultV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: GithubTriageFailureV1 }>;

/** Why a walk stopped with rows the reader can see but a collection it did not finish. */
export type GithubDetailIncompleteReasonV1 = 'pagination' | 'ceiling';

export type GithubDetailPageV1<TRow> = GithubPageProjectionV1<TRow> & Readonly<{
  /** The next page this source will request, or `null` when the walk stopped. */
  nextPage: number | null;
  incomplete: GithubDetailIncompleteReasonV1 | null;
}>;

const REQUEST_INVALID: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_request_invalid',
});

const RESPONSE_SHAPE_INVALID: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_detail_response_invalid',
});

function failed<T>(failure: GithubTriageFailureV1): GithubDetailReadResultV1<T> {
  return Object.freeze({ ok: false as const, failure });
}

function succeeded<T>(value: T): GithubDetailReadResultV1<T> {
  return Object.freeze({ ok: true as const, value });
}

export type GithubDetailReadDependenciesV1 = Readonly<{
  client: GithubApiClientV1;
  now: () => number;
}>;

/**
 * Settles one response into a decoded body, or into the failure that response
 * actually is. A non-success status and an unreadable body are different facts
 * and stay different codes.
 */
function decodeBody(
  response: GithubApiResponseV1,
  nowMs: number,
): Readonly<{ ok: true; body: unknown }>
  | Readonly<{ ok: false; failure: GithubTriageFailureV1 }> {
  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      ok: false as const,
      failure: classifyGithubResponseFailure(response, nowMs),
    });
  }
  try {
    return Object.freeze({ ok: true as const, body: decodeGithubJsonResponse(response) });
  } catch (error) {
    return Object.freeze({ ok: false as const, failure: classifyGithubTransportFailure(error) });
  }
}

/**
 * Reads the page this source will request next.
 *
 * A validated next page that does not ADVANCE is refused: a provider that keeps
 * advertising the page just read would otherwise make a panel walk it forever.
 */
function verifyNextPage(
  response: GithubApiResponseV1,
  requestedUrl: string,
  requestedPage: number,
): Readonly<{ kind: 'ended' }>
  | Readonly<{ kind: 'next'; page: number }>
  | Readonly<{ kind: 'unusable' }> {
  const next = readValidatedGithubFollowUpPage(response.headers, requestedUrl);
  if (next.kind === 'ended') return Object.freeze({ kind: 'ended' as const });
  if (next.kind === 'invalid') return Object.freeze({ kind: 'unusable' as const });
  const page = readGithubValidatedPageNumber(next.url);
  return page === null || page <= requestedPage
    ? Object.freeze({ kind: 'unusable' as const })
    : Object.freeze({ kind: 'next' as const, page });
}

type PagedReadInput = GithubDetailPageRequestV1;

async function readPagedCollection<TRow>(
  dependencies: GithubDetailReadDependenciesV1,
  input: Readonly<{
    url: string;
    page: number;
    project: (body: unknown) => GithubPageProjectionV1<TRow>;
    /** Stated only by the changed-file walk, which has a documented ceiling. */
    ceilingReached?: boolean;
  }>,
): Promise<GithubDetailReadResultV1<GithubDetailPageV1<TRow>>> {
  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.request({ url: input.url });
  } catch (error) {
    return failed(classifyGithubTransportFailure(error));
  }

  const decoded = decodeBody(response, dependencies.now());
  if (!decoded.ok) return failed(decoded.failure);
  if (!Array.isArray(decoded.body)) return failed(RESPONSE_SHAPE_INVALID);

  const projected = input.project(decoded.body);
  const next = verifyNextPage(response, input.url, input.page);
  const hasNext = next.kind === 'next';
  const ceilingReached = input.ceilingReached === true;

  return succeeded(Object.freeze({
    rows: projected.rows,
    omittedRowCount: projected.omittedRowCount,
    projectionTruncated: projected.projectionTruncated,
    nextPage: hasNext && !ceilingReached ? next.page : null,
    incomplete: next.kind === 'unusable'
      ? ('pagination' as const)
      : hasNext && ceilingReached ? ('ceiling' as const) : null,
  }));
}

/* ------------------------------------------------------------------- timeline */

export async function readGithubTimelinePage(
  input: PagedReadInput,
  dependencies: GithubDetailReadDependenciesV1,
): Promise<GithubDetailReadResultV1<GithubDetailPageV1<GithubProjectedTimelineRowV1>>> {
  let url: string;
  try {
    url = buildGithubTimelineUrl(input);
  } catch {
    return failed(REQUEST_INVALID);
  }
  return readPagedCollection(dependencies, {
    url,
    page: input.page,
    project: (body) => projectGithubTimelineRows(body, GITHUB_DETAIL_BOUNDS_V1),
  });
}

/* -------------------------------------------------------------- changed files */

/**
 * One page of the changed-file walk.
 *
 * `GITHUB_CHANGED_FILES_CEILING_V1` is GitHub's own documented maximum, and this
 * is where the walk honours it. Once the pages read cover 3,000 files, the walk
 * stops even if GitHub still advertises a next page — and it SAYS so, because a
 * count that stops at a round number with no explanation reads as a defect in
 * this product rather than a limit of theirs.
 */
export async function readGithubChangedFilesPage(
  input: PagedReadInput,
  dependencies: GithubDetailReadDependenciesV1,
): Promise<GithubDetailReadResultV1<GithubDetailPageV1<GithubProjectedChangedFileRowV1>>> {
  let url: string;
  try {
    url = buildGithubChangedFilesUrl(input);
  } catch {
    return failed(REQUEST_INVALID);
  }
  return readPagedCollection(dependencies, {
    url,
    page: input.page,
    ceilingReached: input.page * input.perPage >= GITHUB_CHANGED_FILES_CEILING_V1,
    project: (body) => projectGithubChangedFileRows(body, GITHUB_DETAIL_BOUNDS_V1),
  });
}

/* ------------------------------------------------------------------- comments */

export async function readGithubIssueCommentsPage(
  input: PagedReadInput,
  dependencies: GithubDetailReadDependenciesV1,
): Promise<GithubDetailReadResultV1<GithubDetailPageV1<GithubProjectedCommentRowV1>>> {
  let url: string;
  try {
    url = buildGithubIssueCommentsUrl(input);
  } catch {
    return failed(REQUEST_INVALID);
  }
  return readPagedCollection(dependencies, {
    url,
    page: input.page,
    project: (body) => projectGithubCommentRows(body, GITHUB_DETAIL_BOUNDS_V1),
  });
}

/* --------------------------------------------------------------------- checks */

export type GithubChecksReadV1 = Readonly<{
  /** The head revision the two check reads were issued against. */
  headRevision: string;
  surface: GithubChecksSurfaceV1;
}>;

const HEAD_REVISION_UNREADABLE: GithubTriageFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_head_revision_unreadable',
});

/**
 * The checks plane's whole read.
 *
 * It begins with the pull request itself because check runs and commit statuses
 * are keyed by COMMIT. Reading them against a head revision remembered from an
 * earlier observation would answer for a commit the pull request has already
 * moved past and present that answer as the current state — the exact race the
 * head revision exists to close. The revision is therefore read here, now, and
 * the two check reads are issued against it.
 */
export async function readGithubChecksSurface(
  input: Readonly<{
    route: GithubRepositoryRouteV1;
    entryNumber: string;
  }>,
  dependencies: GithubDetailReadDependenciesV1 & Readonly<{ signal: AbortSignal }>,
): Promise<GithubDetailReadResultV1<GithubChecksReadV1>> {
  let url: string;
  try {
    url = buildGithubPullRequestUrl(input);
  } catch {
    return failed(REQUEST_INVALID);
  }

  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.request({ url });
  } catch (error) {
    return failed(classifyGithubTransportFailure(error));
  }
  const decoded = decodeBody(response, dependencies.now());
  if (!decoded.ok) return failed(decoded.failure);

  const view = decodeGithubPullRequestBody(decoded.body);
  if (view === null || view.number !== input.entryNumber) {
    return failed(RESPONSE_SHAPE_INVALID);
  }
  const headRevision = view.nativeRevision;
  if (headRevision === null) {
    // A pull request whose head this source cannot read is not a pull request
    // with no checks: there is no commit to ask about, and saying so is the
    // honest answer.
    return failed(HEAD_REVISION_UNREADABLE);
  }

  const surface = await readGithubPullRequestChecks({ route: input.route, headSha: headRevision }, {
    client: dependencies.client,
    now: dependencies.now,
    signal: dependencies.signal,
  });
  return succeeded(Object.freeze({ headRevision, surface }));
}

/* -------------------------------------------------------------------- reviews */

/**
 * The review plane's whole read.
 *
 * It delegates to `reviews.ts`, which is the ONE owner of the two review
 * resources and of the collapse between them. This module supplies only the
 * route, because the detail planes and `get` must not acquire two answers to
 * "who has reviewed this".
 *
 * Unlike the checks read it needs no head revision: a review is submitted
 * against the pull request, not against a commit, and GitHub keeps a dismissed
 * review in the collection rather than removing it when the head moves.
 */
export async function readGithubReviewsSurface(
  input: Readonly<{
    route: GithubRepositoryRouteV1;
    entryNumber: string;
  }>,
  dependencies: GithubDetailReadDependenciesV1 & Readonly<{ signal: AbortSignal }>,
): Promise<GithubReviewersSurfaceV1> {
  return readGithubPullRequestReviewers({
    route: input.route,
    number: input.entryNumber,
  }, {
    client: dependencies.client,
    now: dependencies.now,
    signal: dependencies.signal,
  });
}
