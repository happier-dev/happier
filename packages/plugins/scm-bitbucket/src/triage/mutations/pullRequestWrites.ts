import { readBitbucketApiUrl, type BitbucketTriageApiClient } from '../apiClient.js';
import {
  readBitbucketCommentResolution,
  type BitbucketCommentResolutionV1,
} from '../detail/projection.js';
import { createBitbucketFailure, type BitbucketTriageFailure } from '../failures.js';
import { encodeBitbucketPathSegment } from '../identity.js';
import { buildBitbucketPullRequestUrl } from '../pullRequests.js';
import type { BitbucketEntryRouteV1 } from '../source/invocationAdmission.js';

/**
 * The four enabled Bitbucket Cloud pull-request writes, at the provider boundary.
 *
 * Bitbucket models both as commands on a sub-resource of the pull request, so the URLs are built
 * from the one pull-request URL owner rather than from a second path assembler. Nothing here
 * decides whether a write *should* happen: the currentness gate, the confirming read and the
 * result shaping all belong to the Action above, and this module only turns one documented request
 * into one classified outcome.
 */

function pullRequestCommandUrl(route: BitbucketEntryRouteV1, command: string): string {
  return `${buildBitbucketPullRequestUrl(route)}/${command}`;
}

/** `POST …/pullrequests/{id}/merge`. */
export function buildBitbucketMergeUrl(route: BitbucketEntryRouteV1): string {
  return pullRequestCommandUrl(route, 'merge');
}

/** `POST …/pullrequests/{id}/decline`. */
export function buildBitbucketDeclineUrl(route: BitbucketEntryRouteV1): string {
  return pullRequestCommandUrl(route, 'decline');
}

/**
 * What Bitbucket did with one write request.
 *
 * `queued` exists because Bitbucket's merge "may complete asynchronously, and not at our option":
 * the `202` says the merge was accepted, never that it happened, and the two must not collapse
 * into one success (`sources/SCM.md` §5.3b).
 */
export type BitbucketWriteOutcomeV1 =
  | Readonly<{ kind: 'succeeded' }>
  | Readonly<{ kind: 'queued'; statusUrl: string }>
  | Readonly<{
    kind: 'rejected';
    reason: 'provider-rejected' | 'provider-oversized-response';
    failure: BitbucketTriageFailure;
  }>
  | Readonly<{ kind: 'failed'; failure: BitbucketTriageFailure }>;

/**
 * Bitbucket's two documented terminal merge refusals.
 *
 * They are branched on the exact status rather than on the classified failure, because the
 * classifier answers "what does a reader render" while a merge additionally has to say *which*
 * documented refusal happened. Neither is retried: an ambiguous or refused merge write is reported,
 * never repeated.
 */
const MERGE_REJECTION_STATUSES: Readonly<Record<number, 'provider-rejected' | 'provider-oversized-response'>> =
  Object.freeze({
    409: 'provider-rejected',
    555: 'provider-oversized-response',
  });

/**
 * Bitbucket's own merge parameters, sent exactly as the caller decided them.
 *
 * `close_source_branch` is present on every request because it is required and never defaulted:
 * whether a collaborator's branch survives the merge is the user's decision, not this module's.
 */
export type BitbucketMergeParametersV1 = Readonly<{
  closeSourceBranch: boolean;
  mergeStrategy: 'merge_commit' | 'squash' | 'fast_forward';
  message?: string;
}>;

export async function mergeBitbucketPullRequest(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    parameters: BitbucketMergeParametersV1;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketWriteOutcomeV1> {
  const response = await input.client.requestJson({
    url: buildBitbucketMergeUrl(input.route),
    method: 'POST',
    body: {
      close_source_branch: input.parameters.closeSourceBranch,
      merge_strategy: input.parameters.mergeStrategy,
      ...(input.parameters.message === undefined ? {} : { message: input.parameters.message }),
    },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  if (!response.ok) {
    const reason = response.status === null ? undefined : MERGE_REJECTION_STATUSES[response.status];
    return reason === undefined
      ? { kind: 'failed', failure: response.failure }
      : { kind: 'rejected', reason, failure: response.failure };
  }

  if (response.status !== 202) return { kind: 'succeeded' };

  // A queued merge is only pollable through the location Bitbucket issued for it, and that
  // location receives the materialized credential — so it passes the same origin gate every other
  // forge-supplied URL passes. A `202` without one, or with one pointing somewhere else, is not a
  // response this source will act on: it will not guess where the merge went.
  const statusUrl = readBitbucketApiUrl(
    response.headers['location'] ?? response.headers['Location'],
  );
  if (statusUrl === null) {
    return {
      kind: 'failed',
      failure: createBitbucketFailure('unsupportedContract', 'merge-status-location-untrusted'),
    };
  }
  return { kind: 'queued', statusUrl };
}

export async function declineBitbucketPullRequest(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketWriteOutcomeV1> {
  // Bitbucket documents no request body for this route, so none is sent. A decline reason is a
  // field this source would be inventing, and an invented field is silently ignored at best.
  const response = await input.client.requestJson({
    url: buildBitbucketDeclineUrl(input.route),
    method: 'POST',
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  return response.ok ? { kind: 'succeeded' } : { kind: 'failed', failure: response.failure };
}

/* --------------------------------------------------------- comment resolution */

/**
 * `…/pullrequests/{id}/comments/{commentId}` — one comment, not the collection.
 *
 * It exists here rather than beside the Comments plane's collection route because it is this
 * write's own confirming read: what it answers is whether the resolve or reopen took effect, and
 * nothing mounted reads one comment on its own.
 */
export function buildBitbucketCommentUrl(
  route: BitbucketEntryRouteV1,
  commentId: string,
): string {
  return `${buildBitbucketPullRequestUrl(route)}/comments/${encodeBitbucketPathSegment(commentId)}`;
}

/**
 * `…/comments/{commentId}/resolve` — Bitbucket's one route for both directions.
 *
 * `POST` is documented as *"Resolve a comment thread"* and `DELETE` on the same path as *"Reopen a
 * comment thread"*, so the path is built once and the verb is what the two writes differ by.
 */
export function buildBitbucketCommentResolutionUrl(
  route: BitbucketEntryRouteV1,
  commentId: string,
): string {
  return `${buildBitbucketCommentUrl(route, commentId)}/resolve`;
}

/**
 * What Bitbucket did with one comment-resolution write.
 *
 * It is deliberately not the merge outcome above. `queued` exists there because Bitbucket
 * documents an asynchronous merge and answers `202`; it documents no asynchronous arm here.
 * `rejected` exists there because `409` and `555` are documented merge responses; neither is a
 * documented response to resolving a comment thread, and inventing terminal meanings for statuses
 * the provider never promised is how a generic error starts reading as a specific refusal.
 */
export type BitbucketCommentWriteOutcomeV1 =
  | Readonly<{ kind: 'succeeded' }>
  | Readonly<{ kind: 'failed'; failure: BitbucketTriageFailure }>;

async function writeBitbucketCommentResolution(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    commentId: string;
    signal?: AbortSignal;
  }>,
  method: 'POST' | 'DELETE',
): Promise<BitbucketCommentWriteOutcomeV1> {
  // Bitbucket documents no request body for either direction, so none is sent: a field this source
  // invented is silently ignored at best.
  const response = await input.client.requestJson({
    url: buildBitbucketCommentResolutionUrl(input.route, input.commentId),
    method,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return response.ok ? { kind: 'succeeded' } : { kind: 'failed', failure: response.failure };
}

/** `POST …/comments/{commentId}/resolve` — Bitbucket's "resolve a comment thread". */
export async function resolveBitbucketComment(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    commentId: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketCommentWriteOutcomeV1> {
  return writeBitbucketCommentResolution(input, 'POST');
}

/** `DELETE …/comments/{commentId}/resolve` — Bitbucket's "reopen a comment thread". */
export async function unresolveBitbucketComment(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    commentId: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketCommentWriteOutcomeV1> {
  return writeBitbucketCommentResolution(input, 'DELETE');
}

export type BitbucketCommentReadOutcomeV1 =
  | Readonly<{ ok: true; resolution: BitbucketCommentResolutionV1 }>
  | Readonly<{ ok: false; failure: BitbucketTriageFailure }>;

/**
 * Reads one comment's resolution, through the SAME decoder the Comments panel renders.
 *
 * The tri-state is one fact with one owner: an absent `resolution` key means the deployment said
 * nothing, and a second reader here could start answering *unresolved* to the question the panel
 * answers *unknown*.
 */
export async function readBitbucketCommentResolutionState(
  input: Readonly<{
    client: BitbucketTriageApiClient;
    route: BitbucketEntryRouteV1;
    commentId: string;
    signal?: AbortSignal;
  }>,
): Promise<BitbucketCommentReadOutcomeV1> {
  const response = await input.client.requestJson({
    url: buildBitbucketCommentUrl(input.route, input.commentId),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!response.ok) return { ok: false, failure: response.failure };
  if (typeof response.body !== 'object' || response.body === null) {
    return {
      ok: false,
      failure: createBitbucketFailure('unsupportedContract', 'undecodable-entity'),
    };
  }
  return { ok: true, resolution: readBitbucketCommentResolution(response.body) };
}
