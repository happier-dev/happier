/**
 * Every GitLab detail URL this source builds, built here and nowhere else.
 *
 * The first request of a walk is constructed from a project id this source read
 * back out of its own collision scope and an IID it proved is a positive decimal.
 * Every FOLLOWING request is GitLab's own `Link rel="next"` URL, byte-for-byte:
 * GitLab documents keyset pagination as "use only the given link", so a rebuilt
 * page URL is not the page GitLab offered. That is the exact opposite of the
 * GitHub vertical, which validates a `Link` as the same request with only `page`
 * advanced and then rebuilds it — and the difference is the providers', not a
 * missing abstraction.
 *
 * The window literals below deliberately differ per collection. They are not one
 * shared page policy: a resource event is a few short fields, a note carries a
 * body, and a discussion carries a whole array of notes. `sources/SCM.md` §4.6
 * fixes each one, and a reader control names the count it adds.
 */

import { buildGitlabApiUrl } from '../http/gitlabClient.js';
import type { GitlabConfiguredOrigin } from '../origin.js';
import type { GitlabKindId } from '../types.js';

/** The largest page GitLab accepts on any REST collection. */
export const GITLAB_MAX_DETAIL_PAGE_SIZE_V1 = 100;

/** Merge-request `Activity` mounts the newest 36 notes. */
export const GITLAB_MERGE_REQUEST_NOTES_PAGE_SIZE_V1 = 36;
/** Issue `Comments` mounts the newest 32 notes. */
export const GITLAB_ISSUE_NOTES_PAGE_SIZE_V1 = 32;
/** Merge-request `Activity` mounts the first 30 events from each event source. */
export const GITLAB_MERGE_REQUEST_EVENTS_PAGE_SIZE_V1 = 30;
/** Issue `Activity` mounts the first 28 events from each event source. */
export const GITLAB_ISSUE_EVENTS_PAGE_SIZE_V1 = 28;
/** `Reviews` mounts 18 provider discussion objects. */
export const GITLAB_DISCUSSIONS_PAGE_SIZE_V1 = 18;
/** `Pipelines` mounts one page of the merge request's own pipelines. */
export const GITLAB_PIPELINES_PAGE_SIZE_V1 = 20;
/** One `/diffs` page is a whole number of files, as GitLab paginates the diff itself. */
export const GITLAB_CHANGES_PAGE_SIZE_V1 = 20;

/** The item segment each declared kind is addressed through. */
const KIND_ITEM_SEGMENT: Readonly<Record<GitlabKindId, string>> = Object.freeze({
  'merge-request': 'merge_requests',
  issue: 'issues',
});

/**
 * The three independently cursored activity event sources.
 *
 * They are three endpoints, not three filters of one, and each carries its own
 * `Link`. Reading only `resource_state_events` loses every label and milestone
 * change, which is why the union is built from all three rather than from the
 * one that happens to be cheapest.
 */
export const GITLAB_ACTIVITY_EVENT_SOURCES_V1 = [
  'state',
  'label',
  'milestone',
] as const;
export type GitlabActivityEventSourceV1 = (typeof GITLAB_ACTIVITY_EVENT_SOURCES_V1)[number];

const EVENT_SOURCE_SEGMENT: Readonly<Record<GitlabActivityEventSourceV1, string>> = Object.freeze({
  state: 'resource_state_events',
  label: 'resource_label_events',
  milestone: 'resource_milestone_events',
});

export function isGitlabActivityEventSource(
  value: string,
): value is GitlabActivityEventSourceV1 {
  return (GITLAB_ACTIVITY_EVENT_SOURCES_V1 as readonly string[]).includes(value);
}

/** Positive decimal IID, matching the identity rule the rest of this source uses. */
const IID_PATTERN = /^[1-9][0-9]*$/u;

export type GitlabDetailRouteInputV1 = Readonly<{
  origin: GitlabConfiguredOrigin;
  projectId: number;
  /** The per-project internal id, as it appears in the local ref. */
  iid: string;
  kindId: GitlabKindId;
}>;

function assertRoute(input: GitlabDetailRouteInputV1, perPage?: number): void {
  if (!Number.isSafeInteger(input.projectId) || input.projectId < 1) {
    throw new Error('gitlab_detail_project_invalid');
  }
  if (!IID_PATTERN.test(input.iid)) {
    throw new Error('gitlab_detail_iid_invalid');
  }
  if (perPage !== undefined
    && (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > GITLAB_MAX_DETAIL_PAGE_SIZE_V1)) {
    throw new Error('gitlab_detail_page_size_invalid');
  }
}

function itemPath(input: GitlabDetailRouteInputV1, suffix: string): string {
  return `/projects/${input.projectId}/${KIND_ITEM_SEGMENT[input.kindId]}/${input.iid}${suffix}`;
}

/**
 * The item itself: `…/projects/{id}/{merge_requests|issues}/{iid}`.
 *
 * It is the currentness read every mutation performs before it writes, the
 * confirming read every mutation performs after it writes, and — for the state
 * transitions GitLab expresses as an item update — the write target. One builder
 * for all three is the point: a confirming read that addressed a different route
 * than the write would confirm nothing.
 */
export function buildGitlabItemUrl(input: GitlabDetailRouteInputV1): string {
  assertRoute(input);
  return buildGitlabApiUrl(input.origin, itemPath(input, ''));
}

/**
 * `PUT …/merge_requests/{iid}/merge`.
 *
 * GitLab's own conditional write: the `sha` parameter must match the head of the
 * source branch or the merge fails, which is the provider-native precondition
 * the head pin exists to consume.
 */
export function buildGitlabMergeRequestMergeUrl(input: GitlabDetailRouteInputV1): string {
  assertRoute(input);
  if (input.kindId !== 'merge-request') throw new Error('gitlab_merge_route_kind_invalid');
  return buildGitlabApiUrl(input.origin, itemPath(input, '/merge'));
}

/**
 * `GET …/notes?order_by=created_at&sort=desc&per_page=N`.
 *
 * Descending is what makes "the newest N" mean the newest N; the reader renders
 * them chronologically. It is the same route for both kinds because GitLab
 * serves notes per item, and the item segment is the only difference.
 */
export function buildGitlabNotesUrl(
  input: GitlabDetailRouteInputV1,
  perPage: number,
): string {
  assertRoute(input, perPage);
  return buildGitlabApiUrl(input.origin, itemPath(input, '/notes'), [
    ['order_by', 'created_at'],
    ['sort', 'desc'],
    ['per_page', String(perPage)],
  ]);
}

/**
 * `GET …/resource_{state,label,milestone}_events?per_page=N`.
 *
 * The API documents no temporal order control on these collections, so the
 * reader's follow-up control is `Show N more activity events` and never claims
 * the next response is older.
 */
export function buildGitlabResourceEventsUrl(
  input: GitlabDetailRouteInputV1,
  source: GitlabActivityEventSourceV1,
  perPage: number,
): string {
  assertRoute(input, perPage);
  return buildGitlabApiUrl(
    input.origin,
    itemPath(input, `/${EVENT_SOURCE_SEGMENT[source]}`),
    [['per_page', String(perPage)]],
  );
}

/** `GET …/merge_requests/{iid}/discussions?per_page=N`. */
export function buildGitlabDiscussionsUrl(
  input: GitlabDetailRouteInputV1,
  perPage: number,
): string {
  assertRoute(input, perPage);
  return buildGitlabApiUrl(input.origin, itemPath(input, '/discussions'), [
    ['per_page', String(perPage)],
  ]);
}

/**
 * `GET …/merge_requests/{iid}/approvals`.
 *
 * GitLab annotates this endpoint `Tier: Free, Premium, Ultimate`, so it is read
 * on every tier and its result is never gated behind an edition check.
 */
export function buildGitlabApprovalsUrl(input: GitlabDetailRouteInputV1): string {
  assertRoute(input);
  return buildGitlabApiUrl(input.origin, itemPath(input, '/approvals'));
}

/**
 * `GET …/merge_requests/{iid}/approval_rules`.
 *
 * Premium/Ultimate only. A `403` or `404` here means *not licensed*, and is
 * reported as `edition_unsupported` rather than as a failure.
 */
export function buildGitlabApprovalRulesUrl(input: GitlabDetailRouteInputV1): string {
  assertRoute(input);
  return buildGitlabApiUrl(input.origin, itemPath(input, '/approval_rules'));
}

/** `GET …/merge_requests/{iid}/pipelines?per_page=N`. */
export function buildGitlabMergeRequestPipelinesUrl(
  input: GitlabDetailRouteInputV1,
  perPage: number,
): string {
  assertRoute(input, perPage);
  return buildGitlabApiUrl(input.origin, itemPath(input, '/pipelines'), [
    ['per_page', String(perPage)],
  ]);
}

/**
 * `GET /projects/{id}/pipelines/{pipelineId}/jobs`.
 *
 * Project-scoped rather than item-scoped: a pipeline belongs to the project, and
 * the merge request only names which pipelines are its own.
 */
export function buildGitlabPipelineJobsUrl(input: Readonly<{
  origin: GitlabConfiguredOrigin;
  projectId: number;
  pipelineId: number;
  perPage: number;
}>): string {
  if (!Number.isSafeInteger(input.projectId) || input.projectId < 1
    || !Number.isSafeInteger(input.pipelineId) || input.pipelineId < 1) {
    throw new Error('gitlab_detail_pipeline_invalid');
  }
  if (!Number.isSafeInteger(input.perPage)
    || input.perPage < 1
    || input.perPage > GITLAB_MAX_DETAIL_PAGE_SIZE_V1) {
    throw new Error('gitlab_detail_page_size_invalid');
  }
  return buildGitlabApiUrl(
    input.origin,
    `/projects/${input.projectId}/pipelines/${input.pipelineId}/jobs`,
    [['per_page', String(input.perPage)]],
  );
}

/**
 * `GET …/merge_requests/{iid}/diffs?page=&per_page=`.
 *
 * The current endpoint, always. The deprecated `…/changes` path and its
 * `access_raw_diffs=true` companion are not built here: V1 admits GitLab.com
 * only (`sources/SCM.md` §4.1b), and GitLab.com serves the current contract, so
 * a legacy branch would be code no admitted deployment can reach.
 */
export function buildGitlabDiffsUrl(
  input: GitlabDetailRouteInputV1,
  page: number,
  perPage: number,
): string {
  assertRoute(input, perPage);
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error('gitlab_detail_page_invalid');
  }
  return buildGitlabApiUrl(input.origin, itemPath(input, '/diffs'), [
    ['page', String(page)],
    ['per_page', String(perPage)],
  ]);
}
