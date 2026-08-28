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
import { selectGitlabNextPageUrl } from '../http/gitlabLink.js';
import type { GitlabFailure } from '../types.js';

import {
  GITLAB_DETAIL_BOUNDS_V1,
  projectGitlabActivityEventRows,
  projectGitlabApprovalRules,
  projectGitlabApprovalState,
  projectGitlabChangedFileRows,
  projectGitlabDiscussionRows,
  projectGitlabNoteRows,
  projectGitlabPipelineRollup,
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

function failed<T>(failure: GitlabFailure): GitlabDetailReadResultV1<T> {
  return Object.freeze({ ok: false as const, failure });
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
  if (!Array.isArray(result.response.body)) return failed(RESPONSE_SHAPE_INVALID);

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

export async function readGitlabChangesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
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
  return readPagedCollection<GitlabChangedFilesProjectionV1>(dependencies, {
    url: url.url,
    project: (body) => projectGitlabChangedFileRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
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
}>;

async function readCompleteGitlabPipelineRollup(
  firstUrl: string,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabPipelineRollupV1 | null> {
  let url = firstUrl;
  const visited = new Set<string>();
  let failingCount = 0;
  let runningCount = 0;
  let passingCount = 0;

  while (!visited.has(url)) {
    visited.add(url);
    const jobs = await requestGitlabJson({
      invocation: dependencies.invocation,
      url,
      fetcher: dependencies.fetcher,
      signal: dependencies.signal,
      nowMs: dependencies.nowMs,
    });
    if (jobs.kind === 'failed') return null;

    const pageRollup = projectGitlabPipelineRollup(jobs.response.body);
    if (pageRollup === null) return null;
    failingCount += pageRollup.failingCount;
    runningCount += pageRollup.runningCount;
    passingCount += pageRollup.passingCount;

    const next = selectGitlabNextPageUrl(
      jobs.response.headers,
      dependencies.invocation.origin.normalized,
    );
    if (next.kind === 'end') {
      return Object.freeze({ failingCount, runningCount, passingCount });
    }
    if (next.kind === 'refused' || visited.has(next.url)) return null;
    url = next.url;
  }

  return null;
}

/**
 * One page of the merge request's pipelines, plus the newest pipeline's rollup.
 *
 * The rollup needs a second read — GitLab's pipeline row carries a status but no
 * per-job breakdown — and that read is allowed to fail without taking the page
 * with it. What it may never do is answer `0 failing` when it failed: `null` and
 * `{0,0,0}` are different answers and this is where they stay different.
 */
export async function readGitlabPipelinesPage(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    perPage: number;
    position: GitlabDetailPagePositionV1;
  }>,
  dependencies: GitlabDetailReadDependenciesV1,
): Promise<GitlabDetailReadResultV1<GitlabPipelinesReadV1>> {
  const url = resolveUrl(
    input.position,
    () => buildGitlabMergeRequestPipelinesUrl(input.route, input.perPage),
  );
  if (!url.ok) return failed(url.failure);
  const page = await readPagedCollection(dependencies, {
    url: url.url,
    project: (body) => projectGitlabPipelineRows(body, GITLAB_DETAIL_BOUNDS_V1, input.perPage),
  });
  if (!page.ok) return failed(page.failure);

  const newest = page.value.rows[0];
  if (newest === undefined) {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null }));
  }

  const pipelineId = Number(newest.id);
  if (!Number.isSafeInteger(pipelineId) || pipelineId < 1) {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null }));
  }

  let jobsUrl: string;
  try {
    jobsUrl = buildGitlabPipelineJobsUrl({
      origin: dependencies.invocation.origin,
      projectId: input.route.projectId,
      pipelineId,
      perPage: input.perPage,
    });
  } catch {
    return succeeded(Object.freeze({ ...page.value, rollup: null, rollupPipelineId: null }));
  }

  const rollup = await readCompleteGitlabPipelineRollup(jobsUrl, dependencies);
  return succeeded(Object.freeze({
    ...page.value,
    rollup,
    rollupPipelineId: rollup === null ? null : newest.id,
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
  if (state === null) return failed(RESPONSE_SHAPE_INVALID);

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
    return Object.freeze({ kind: 'unavailable' as const, failure: RESPONSE_SHAPE_INVALID });
  }
  const projected = projectGitlabApprovalRules(response.response.body, GITLAB_DETAIL_BOUNDS_V1);
  return Object.freeze({
    kind: 'available' as const,
    rules: projected.rows,
    omittedRuleCount: projected.omittedRowCount,
    projectionTruncated: projected.projectionTruncated,
  });
}
