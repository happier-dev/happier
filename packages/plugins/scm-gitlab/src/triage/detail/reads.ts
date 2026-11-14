/**
 * The bounded reads behind the GitLab detail planes.
 *
 * Each one issues exactly one request per page, decodes it, projects it at the
 * boundary, and states where the walk stands. None of them retains a credential,
 * caches, or holds state between invocations: a mounted panel's position lives
 * in a source-minted continuation and nowhere else.
 *
 * The next page is GitLab's own `Link rel="next"` URL, followed byte-for-byte
 * and admitted against the exact origin this invocation was authorized for. A
 * cross-origin `Link` is dropped rather than followed — sending the binding's
 * credential to another host is a credential disclosure, and a page answered by
 * another host is a confidently wrong list.
 *
 * Two walk outcomes are kept distinct because they are two different answers:
 *
 * - the collection ran out — the walk ended, and nothing is claimed about
 *   completeness beyond what was read;
 * - GitLab advertised a next page this source will not follow — the rows already
 *   read are kept and the walk is reported `incomplete: 'pagination'`.
 */

import {
  requestGitlabJson,
  requestGitlabText,
  type GitlabAuthorizedInvocation,
  type GitlabHttpFetcher,
} from '../http/gitlabClient.js';
import { isGitlabPageWithinResource, selectGitlabNextPageUrl } from '../http/gitlabLink.js';
import type { GitlabFailure } from '../types.js';
import { buildGitlabEntryIdentity } from '../identity.js';
import { readGitlabComparisonEndpoints, type GitlabComparisonEndpoints } from '../mapping/mergeRequestHead.js';
import type { GitlabComparisonFileV1 } from './contracts.js';

import {
  GITLAB_DETAIL_BOUNDS_V1,
  projectGitlabActivityEventRows,
  projectGitlabApprovalRules,
  projectGitlabApprovalState,
  projectGitlabChangedFileRows,
  projectGitlabDiscussionRows,
  projectGitlabNoteRows,
  projectGitlabPipelineRollup,
  projectGitlabPipelineJobs,
  projectGitlabPipelineRows,
  type GitlabChangedFilesProjectionV1,
  type GitlabPageProjectionV1,
  type GitlabPipelineRollupV1,
  type GitlabProjectedActivityEventRowV1,
  type GitlabProjectedApprovalRuleV1,
  type GitlabProjectedApprovalStateV1,
  type GitlabProjectedDiscussionRowV1,
  type GitlabProjectedNoteRowV1,
  type GitlabProjectedPipelineRowV1,
} from './projection.js';
import {
  buildGitlabApprovalRulesUrl,
  buildGitlabApprovalsUrl,
  buildGitlabDiffsUrl,
  buildGitlabItemUrl,
  buildGitlabRawDiffsUrl,
  buildGitlabDiscussionsUrl,
  buildGitlabMergeRequestPipelinesUrl,
  buildGitlabNotesUrl,
  buildGitlabPipelineJobsUrl,
  buildGitlabResourceEventsUrl,
  type GitlabActivityEventSourceV1,
  type GitlabDetailRouteInputV1,
} from './routes.js';

export type GitlabDetailReadResultV1<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; failure: GitlabFailure }>;

/** Where one settled page left the walk. */
export type GitlabWalkPositionV1 = Readonly<{
  /** GitLab's own next-page URL, or `null` when the walk stopped. */
  nextUrl: string | null;
  incomplete: 'pagination' | null;
}>;

export type GitlabDetailPageV1<TRow> = GitlabPageProjectionV1<TRow> & GitlabWalkPositionV1;

const REQUEST_INVALID: GitlabFailure = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-request-invalid',
});

const RESPONSE_SHAPE_INVALID: GitlabFailure = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-detail-response-invalid',
});

function failed<T>(failure: GitlabFailure, requestId?: string): GitlabDetailReadResultV1<T> {
  return Object.freeze({
    ok: false as const,
    failure: failure.requestId || !requestId ? failure : Object.freeze({ ...failure, requestId }),
  });
}

function succeeded<T>(value: T): GitlabDetailReadResultV1<T> {
  return Object.freeze({ ok: true as const, value });
}

export type GitlabDetailReadDependenciesV1 = Readonly<{
  invocation: GitlabAuthorizedInvocation;
  fetcher: GitlabHttpFetcher;
  signal: AbortSignal;
  nowMs: number;
}>;

/**
 * The URL one page of a walk requests: the first page this source builds, or the
 * exact next URL GitLab issued for the previous one.
 */
export type GitlabDetailPagePositionV1 =
  | Readonly<{ kind: 'first' }>
  | Readonly<{ kind: 'continued'; nextUrl: string }>;

async function readPagedCollection<TProjection extends GitlabPageProjectionV1<unknown>>(
  dependencies: GitlabDetailReadDependenciesV1,
  input: Readonly<{
    url: string;
    project: (body: unknown) => TProjection;
  }>,
): Promise<GitlabDetailReadResultV1<TProjection & GitlabWalkPositionV1>> {
  const result = await requestGitlabJson({
    invocation: dependencies.invocation,
    url: input.url,
    fetcher: dependencies.fetcher,
    signal: dependencies.signal,
    nowMs: dependencies.nowMs,
  });
  if (result.kind === 'failed') return failed(result.failure);
  if (!Array.isArray(result.response.body)) return failed(RESPONSE_SHAPE_INVALID, result.response.requestId);

  const projected = input.project(result.response.body);
  const selection = selectGitlabNextPageUrl(
    result.response.headers,
    dependencies.invocation.origin.normalized,
  );
  // A next page that repeats the URL just read would make a panel walk forever,
  // so it is refused as unusable rather than followed. A `next` GitLab named but this
  // invocation may not follow is the same kind of fact and gets the same arm: the
  // collection has a further page this panel cannot read, which is never the same
  // answer as the collection ending.
  const advances = selection.kind === 'next' && selection.url !== input.url;
  return succeeded(Object.freeze({
    ...projected,
    nextUrl: advances ? selection.url : null,
    incomplete: selection.kind !== 'end' && !advances ? ('pagination' as const) : null,
  }));
}

function resolveUrl(
  position: GitlabDetailPagePositionV1,
  buildFirst: () => string,
): Readonly<{ ok: true; url: string }> | Readonly<{ ok: false; failure: GitlabFailure }> {
  if (position.kind === 'continued') {
    return Object.freeze({ ok: true as const, url: position.nextUrl });
  }
  try {
    return Object.freeze({ ok: true as const, url: buildFirst() });
  } catch {
    return Object.freeze({ ok: false as const, failure: REQUEST_INVALID });
  }
}

/* --------------------------------------------------------------------- notes */

export async function readGitlabNotesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabDetailPageV1<GitlabProjectedNoteRowV1>>> {
  const url = resolveUrl(input.position, () => buildGitlabNotesUrl(input.route, input.perPage));
  if (!url.ok) return failed(url.failure);
  return readPagedCollection(dependencies, {
    url: url.url,
    project: (body) => projectGitlabNoteRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
}

/* ------------------------------------------------------------ activity events */

export async function readGitlabActivityEventsPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    source: GitlabActivityEventSourceV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabDetailPageV1<GitlabProjectedActivityEventRowV1>>> {
  const url = resolveUrl(
    input.position,
    () => buildGitlabResourceEventsUrl(input.route, input.source, input.perPage),
  );
  if (!url.ok) return failed(url.failure);
  return readPagedCollection(dependencies, {
    url: url.url,
    project: (body) => projectGitlabActivityEventRows(
      body,
      input.source,
      GITLAB_DETAIL_BOUNDS_V1,
      input.perPage,
    ),
  });
}

/* --------------------------------------------------------------- discussions */

export async function readGitlabDiscussionsPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabDetailPageV1<GitlabProjectedDiscussionRowV1>>> {
  const url = resolveUrl(
    input.position,
    () => buildGitlabDiscussionsUrl(input.route, input.perPage),
  );
  if (!url.ok) return failed(url.failure);
  return readPagedCollection(dependencies, {
    url: url.url,
    project: (body) => projectGitlabDiscussionRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
}

/* ------------------------------------------------------------------- changes */

type GitlabChangesPageInput = Readonly<{
  route: GitlabDetailRouteInputV1;
  perPage: number;
  position: GitlabDetailPagePositionV1;
}>;

export function readGitlabChangesPage(
  input: GitlabChangesPageInput & Readonly<{ comparison: true }>, dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabChangedFilesProjectionV1<GitlabComparisonFileV1> & GitlabWalkPositionV1>>;
export function readGitlabChangesPage(
  input: GitlabChangesPageInput, dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabChangedFilesProjectionV1 & GitlabWalkPositionV1>>;
export async function readGitlabChangesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
    comparison?: true;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabChangedFilesProjectionV1 & GitlabWalkPositionV1>> {
  const url = resolveUrl(
    input.position,
    // Page 1 explicitly: every following page is GitLab's own next URL, so this
    // source never constructs page 2.
    () => buildGitlabDiffsUrl(input.route, 1, input.perPage),
  );
  if (!url.ok) return failed(url.failure);
  const resource = buildGitlabDiffsUrl(input.route, 1, input.perPage);
  if (!isGitlabPageWithinResource(url.url, resource)) return failed(REQUEST_INVALID);
  const page = await readPagedCollection<GitlabChangedFilesProjectionV1>(dependencies, {
    url: url.url,
    project: (body) => input.comparison === true
      ? projectGitlabChangedFileRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage, true)
      : projectGitlabChangedFileRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
  if (!page.ok || page.value.nextUrl === null || isGitlabPageWithinResource(page.value.nextUrl, resource)) return page;
  return succeeded({ ...page.value, nextUrl: null, incomplete: 'pagination' });
}

/** Brackets each diff page with the same identity-checked metadata read. */
export async function readGitlabComparisonMetadata(
  route: GitlabDetailRouteInputV1,
  collisionScope: string,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabComparisonEndpoints>> {
  const result = await requestGitlabJson({ invocation: dependencies.invocation, url: buildGitlabItemUrl(route),
    fetcher: dependencies.fetcher, signal: dependencies.signal, nowMs: dependencies.nowMs });
  if (result.kind === 'failed') return failed(result.failure);
  const body = result.response.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return failed(RESPONSE_SHAPE_INVALID, result.response.requestId);
  const identity = buildGitlabEntryIdentity({ kindId: 'merge-request', origin: route.origin,
    row: body as Readonly<Record<string, unknown>> });
  if (identity.kind !== 'built' || identity.identity.collisionScope !== collisionScope
    || identity.identity.entryId !== route.iid || identity.locator.repositoryKey !== route.repositoryKey) return failed(RESPONSE_SHAPE_INVALID, result.response.requestId);
  const endpoints = readGitlabComparisonEndpoints(body);
  return endpoints === null ? failed({ class: 'unsupportedContract', code: 'gitlab-comparison-endpoints-unavailable' }, result.response.requestId) : succeeded(endpoints);
}

/**
 * Reads GitLab's explicit raw-evidence resource without interpreting its text.
 * It shares the canonical origin/auth/status/cancellation path with JSON reads.
 */
export async function readGitlabRawDiffText(
  route: GitlabDetailRouteInputV1,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<string>> {
  let url: string;
  try {
    url = buildGitlabRawDiffsUrl(route);
  } catch {
    return failed(REQUEST_INVALID);
  }
  const result = await requestGitlabText({
    invocation: dependencies.invocation,
    url,
    accept: 'text/plain',
    fetcher: dependencies.fetcher,
    signal: dependencies.signal,
    nowMs: dependencies.nowMs,
  });
  return result.kind === 'failed'
    ? failed(result.failure)
    : succeeded(result.response.bodyText);
}

/* ----------------------------------------------------------------- pipelines */

export type GitlabPipelinesReadV1 = GitlabDetailPageV1<GitlabProjectedPipelineRowV1> & Readonly<{
  /** `null` whenever the per-job breakdown could not be read, never zeroes. */
  rollup: GitlabPipelineRollupV1 | null;
  rollupPipelineId: string | null;
  jobs: ReturnType<typeof projectGitlabPipelineJobs> & Readonly<{ total: number | null; failure?: GitlabFailure }>;
}>;

async function readCompleteGitlabPipelineRollup(
  firstUrl: string,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<Readonly<{ rollup: GitlabPipelineRollupV1 | null; jobs: GitlabPipelinesReadV1['jobs'] }>> {
  let url = firstUrl;
  const visited = new Set<string>();
  let failingCount = 0;
  let runningCount = 0;
  let passingCount = 0;
  let total = 0;
  const rows: GitlabPipelinesReadV1['jobs']['rows'][number][] = [];
  let projectionTruncated = false;
  let incomplete = false;
  const partial = (failure?: GitlabFailure) => ({
    rollup: null,
    jobs: { rows, total: null, incomplete: true, projectionTruncated, ...(failure === undefined ? {} : { failure }) },
  });

  while (!visited.has(url)) {
    visited.add(url);
    const jobs = await requestGitlabJson({
      invocation: dependencies.invocation,
      url,
      fetcher: dependencies.fetcher,
      signal: dependencies.signal,
      nowMs: dependencies.nowMs,
    });
    if (jobs.kind === 'failed') return partial(jobs.failure);

    const projected = projectGitlabPipelineJobs(jobs.response.body);
    rows.push(...projected.rows);
    incomplete ||= projected.incomplete;
    projectionTruncated ||= projected.projectionTruncated;
    const pageRollup = projectGitlabPipelineRollup(jobs.response.body);
    if (pageRollup === null) return partial({
      ...RESPONSE_SHAPE_INVALID,
      ...(jobs.response.requestId === undefined ? {} : { requestId: jobs.response.requestId }),
    });
    total += Array.isArray(jobs.response.body) ? jobs.response.body.length : 0;
    failingCount += pageRollup.failingCount;
    runningCount += pageRollup.runningCount;
    passingCount += pageRollup.passingCount;

    const next = selectGitlabNextPageUrl(
      jobs.response.headers,
      dependencies.invocation.origin.normalized,
    );
    if (next.kind === 'end') {
      return Object.freeze({
        rollup: Object.freeze({ failingCount, runningCount, passingCount }),
        jobs: { rows, total, incomplete, projectionTruncated },
      });
    }
    if (next.kind !== 'next' || visited.has(next.url)) return partial();
    url = next.url;
  }

  return partial();
}

/** One page of native pipeline statuses, without reading their jobs. */
export async function readGitlabPipelineStatusesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabDetailPageV1<GitlabProjectedPipelineRowV1>>> {
  const url = resolveUrl(
    input.position,
    () => buildGitlabMergeRequestPipelinesUrl(input.route, input.perPage),
  );
  if (!url.ok) return failed(url.failure);
  return readPagedCollection(dependencies, {
    url: url.url,
    project: (body) => projectGitlabPipelineRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
}

/**
 * Explicit Checks demand adds the newest pipeline's full per-job breakdown.
 * A failed breakdown remains unknown rather than becoming zero failing jobs.
 */
export async function readGitlabPipelinesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabPipelinesReadV1>> {
  const page = await readGitlabPipelineStatusesPage(input, dependencies);
  if (!page.ok) return failed(page.failure);

  const newest = page.value.rows[0];
  const unknownJobs: GitlabPipelinesReadV1['jobs'] = { rows: [], total: null, incomplete: true, projectionTruncated: false };
  if (newest === undefined) {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null,
      jobs: page.value.omittedRowCount === 0 && page.value.incomplete === null
        ? { rows: [], total: 0, incomplete: false, projectionTruncated: false } : unknownJobs,
    }));
  }

  const pipelineId = Number(newest.id);
  if (!Number.isSafeInteger(pipelineId) || pipelineId < 1) {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null, jobs: unknownJobs }));
  }

  let jobsUrl: string;
  try {
    jobsUrl = buildGitlabPipelineJobsUrl({
      origin: dependencies.invocation.origin,
      repositoryKey: input.route.repositoryKey,
      pipelineId,
      perPage: input.perPage,
    });
  } catch {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null, jobs: unknownJobs }));
  }

  const { rollup, jobs } = await readCompleteGitlabPipelineRollup(jobsUrl, dependencies);
  return succeeded(Object.freeze({
    ...page.value,
    rollup,
    rollupPipelineId: rollup === null ? null : newest.id,
    jobs,
  }));
}

/* ----------------------------------------------------------------- approvals */

export type GitlabApprovalRulesReadV1 =
  | Readonly<{
    kind: 'available';
    rules: readonly GitlabProjectedApprovalRuleV1[];
    omittedRuleCount: number;
    projectionTruncated: boolean;
  }>
  | Readonly<{ kind: 'editionUnsupported' }>
  | Readonly<{ kind: 'unavailable'; failure: GitlabFailure }>;

export type GitlabApprovalsReadV1 = Readonly<{
  state: GitlabProjectedApprovalStateV1;
  rules: GitlabApprovalRulesReadV1;
}>;

/**
 * The approval surface of one merge request.
 *
 * Approval STATE and the approve verb are `Tier: Free, Premium, Ultimate`;
 * approval RULES are not. So the state read decides the plane, and the rules
 * read degrades on its own: a `403` or `404` there means *not licensed*, and
 * rendering it as a failure would take a working Free-tier tab down over a
 * feature that account never had.
 */
export async function readGitlabApprovalsSurface(
  input: Readonly<{ route: GitlabDetailRouteInputV1 }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabApprovalsReadV1>> {
  let stateUrl: string;
  let rulesUrl: string;
  try {
    stateUrl = buildGitlabApprovalsUrl(input.route);
    rulesUrl = buildGitlabApprovalRulesUrl(input.route);
  } catch {
    return failed(REQUEST_INVALID);
  }

  const stateResponse = await requestGitlabJson({
    invocation: dependencies.invocation,
    url: stateUrl,
    fetcher: dependencies.fetcher,
    signal: dependencies.signal,
    nowMs: dependencies.nowMs,
  });
  if (stateResponse.kind === 'failed') return failed(stateResponse.failure);
  const state = projectGitlabApprovalState(stateResponse.response.body, GITLAB_DETAIL_BOUNDS_V1);
  if (state === null) return failed(RESPONSE_SHAPE_INVALID, stateResponse.response.requestId);

  const rulesResponse = await requestGitlabJson({
    invocation: dependencies.invocation,
    url: rulesUrl,
    fetcher: dependencies.fetcher,
    signal: dependencies.signal,
    nowMs: dependencies.nowMs,
  });
  return succeeded(Object.freeze({
    state,
    rules: projectApprovalRulesRead(rulesResponse),
  }));
}

/** GitLab's licence answer on the rules route, told apart from a real failure. */
function projectApprovalRulesRead(
  response: Awaited<ReturnType<typeof requestGitlabJson>>,
): GitlabApprovalRulesReadV1 {
  if (response.kind === 'failed') {
    // `forbidden` and `not-found` on a Premium-only path are how GitLab says
    // "your tier does not have this", not "something went wrong".
    return response.failure.code === 'forbidden' || response.failure.code === 'not-found'
      ? Object.freeze({ kind: 'editionUnsupported' as const })
      : Object.freeze({ kind: 'unavailable' as const, failure: response.failure });
  }
  if (!Array.isArray(response.response.body)) {
    return Object.freeze({
      kind: 'unavailable' as const,
      failure: Object.freeze({
        ...RESPONSE_SHAPE_INVALID,
        ...(response.response.requestId === undefined ? {} : { requestId: response.response.requestId }),
      }),
    });
  }
  const projected = projectGitlabApprovalRules(response.response.body, GITLAB_DETAIL_BOUNDS_V1);
  return Object.freeze({
    kind: 'available' as const,
    rules: projected.rows,
    omittedRuleCount: projected.omittedRowCount,
    projectionTruncated: projected.projectionTruncated,
  });
}
