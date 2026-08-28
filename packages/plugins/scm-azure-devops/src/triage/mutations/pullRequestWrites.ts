import type { AzureRequestableThreadStatusV1 } from './contracts.js';
import type { AzureDevOpsApiClient, AzureDevOpsFailure } from '../types.js';

type AzurePullRequestRouteAddress = Readonly<{
  project: string;
  repositoryId: string;
  pullRequestId: number;
}>;

/**
 * The enabled Azure DevOps pull-request writes, at the provider boundary.
 *
 * Azure expresses the three status transitions — complete, abandon and reactivate — as an update
 * of the pull-request resource itself; there is no `/merge` or `/close` sub-resource, so all three
 * are a `PATCH` through the one route builder, which means all three carry the pinned
 * `api-version` the whole vertical is built on rather than whatever the server would default to.
 * Reviewer additions and thread status are sub-resource writes through that same builder.
 *
 * Two Azure facts shape everything here:
 *
 * - **Only seven properties may be updated** (`Status`, `Title`, `Description`, `CompletionOptions`,
 *   `MergeOptions`, `AutoCompleteSetBy.Id`, `TargetRefName`). Attempting another *"will either
 *   cause the server to throw an `InvalidArgumentValueException`, or to **silently ignore the
 *   update**"*. So this module sends nothing outside that set, and the caller confirms by comparing
 *   the values it sent.
 * - **A `200` acknowledges the request, not the merge.** `PullRequestStatus` and `mergeStatus` are
 *   separate fields and the type is literally named `PullRequestAsyncStatus`; terminal success is
 *   read from a later observation, never from this response.
 */

/** Azure's own completion options, sent in full on every completion request. */
export type AzureCompletionOptionsRequestV1 = Readonly<{
  /** The caller's branch decision. Required, never defaulted. */
  deleteSourceBranch: boolean;
  /**
   * Always `false`, and always sent.
   *
   * Completing a pull request is an SCM action; moving somebody's Work Items is a separate product
   * effect this vertical does not own. Omitting the field would inherit whatever a stored
   * completion option or an Azure default decided, which is the same as deciding it silently.
   */
  transitionWorkItems: false;
  /**
   * Always `false`, and always sent, for the same reason.
   *
   * Bypassing branch policy is an authority the user did not grant by pressing *complete*, and an
   * omitted `bypassPolicy` is not a stated `false`.
   */
  bypassPolicy: false;
  /**
   * Always `''`, and always sent, for the same reason as its neighbour.
   *
   * `bypassReason` is the justification Azure stores and displays next to a policy bypass, and it
   * is a *stored* completion option like the other three: somebody who enabled auto-complete
   * through the web UI can already have written one. A completion that sends `bypassPolicy: false`
   * while omitting the reason leaves that stranded text attached to a merge this build performed,
   * attributing a justification nobody here wrote. Sending the empty string states the absence
   * rather than inheriting the presence.
   */
  bypassReason: '';
}>;

/**
 * Whether Azure accepted the update — and nothing more.
 *
 * The response body is deliberately not decoded here. A completion's `200` acknowledges the status
 * update, so the only thing that can say what happened is a later observation of the pull request
 * itself, which the Action above owns.
 */
export type AzureWriteOutcomeV1 =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

export type AzureCreatedCommentOutcomeV1 =
  | Readonly<{ ok: true; externalRef: string }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

/**
 * `PATCH …/pullRequests/{id}` with `status: 'completed'` and the full completion options.
 *
 * The returned row is decoded by the caller's confirming observation rather than trusted here: this
 * response says the update was accepted, and accepting a completion is not completing it.
 */
export async function completeAzurePullRequest(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    completionOptions: AzureCompletionOptionsRequestV1;
    signal: AbortSignal;
  }>,
): Promise<AzureWriteOutcomeV1> {
  const response = await input.client.request({
    route: {
      resource: 'pullRequest',
      project: input.address.project,
      repositoryId: input.address.repositoryId,
      pullRequestId: input.address.pullRequestId,
    },
    method: 'PATCH',
    body: {
      status: 'completed',
      completionOptions: {
        deleteSourceBranch: input.completionOptions.deleteSourceBranch,
        transitionWorkItems: input.completionOptions.transitionWorkItems,
        bypassPolicy: input.completionOptions.bypassPolicy,
        bypassReason: input.completionOptions.bypassReason,
      },
    },
    signal: input.signal,
  });
  return response.ok ? { ok: true } : { ok: false, failure: response.failure };
}

/** `PATCH …/pullRequests/{id}` with `status: 'abandoned'`, and nothing else. */
export async function abandonAzurePullRequest(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    signal: AbortSignal;
  }>,
): Promise<AzureWriteOutcomeV1> {
  return patchAzurePullRequestStatus(input, 'abandoned');
}

/**
 * `PATCH …/pullRequests/{id}` with `status: 'active'`, and nothing else.
 *
 * Azure's own reopen. `completionOptions` is deliberately not resent: it is one of the seven
 * updatable properties and resending it here would re-decide a branch outcome nobody asked about
 * while reactivating.
 */
export async function reactivateAzurePullRequest(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    signal: AbortSignal;
  }>,
): Promise<AzureWriteOutcomeV1> {
  return patchAzurePullRequestStatus(input, 'active');
}

async function patchAzurePullRequestStatus(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    signal: AbortSignal;
  }>,
  status: 'abandoned' | 'active',
): Promise<AzureWriteOutcomeV1> {
  const response = await input.client.request({
    route: {
      resource: 'pullRequest',
      project: input.address.project,
      repositoryId: input.address.repositoryId,
      pullRequestId: input.address.pullRequestId,
    },
    method: 'PATCH',
    body: { status },
    signal: input.signal,
  });
  return response.ok ? { ok: true } : { ok: false, failure: response.failure };
}

/* ----------------------------------------------------------------- reviewers */

/**
 * The exact body Azure's additive reviewer route receives, and the only shape it can receive.
 *
 * Azure's `IdentityRefWithVote` carries `vote`, `isRequired`, `displayName` and more, and the bulk
 * route accepts them — which is precisely why this encoder builds each element from the id alone
 * rather than copying a caller's object. A spread here would let a `vote` reach the provider and
 * reset somebody's approval as a side effect of requesting a review.
 *
 * It also refuses anything that is not a non-empty identity id, so a malformed selection fails
 * before a request rather than sending a partially valid array.
 */
export function encodeAzureReviewerAdditions(
  reviewerIds: readonly string[],
): readonly Readonly<{ id: string }>[] | null {
  if (reviewerIds.length === 0) return null;
  const encoded: Readonly<{ id: string }>[] = [];
  for (const reviewerId of reviewerIds) {
    if (typeof reviewerId !== 'string' || reviewerId.trim().length === 0) return null;
    encoded.push(Object.freeze({ id: reviewerId }));
  }
  return Object.freeze(encoded);
}

/**
 * `POST …/pullRequests/{id}/reviewers` with a strict identity-only array.
 *
 * One additive bulk request, never the per-reviewer `PUT …/reviewers/{reviewerId}` create-or-vote
 * route and never a replacement set: this call adds the named identities and states nothing about
 * anybody else's membership or vote.
 */
export async function addAzurePullRequestReviewers(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    reviewers: readonly Readonly<{ id: string }>[];
    signal: AbortSignal;
  }>,
): Promise<AzureWriteOutcomeV1> {
  const response = await input.client.request({
    route: {
      resource: 'reviewers',
      project: input.address.project,
      repositoryId: input.address.repositoryId,
      pullRequestId: input.address.pullRequestId,
    },
    method: 'POST',
    body: input.reviewers,
    signal: input.signal,
  });
  return response.ok ? { ok: true } : { ok: false, failure: response.failure };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Creates one new thread and returns its provider-native thread/comment pair. */
export async function createAzurePullRequestThread(input: Readonly<{
  client: AzureDevOpsApiClient;
  address: AzurePullRequestRouteAddress;
  body: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}>): Promise<AzureCreatedCommentOutcomeV1> {
  const response = await input.client.request({
    route: { resource: 'threads', ...input.address },
    method: 'POST',
    body: input.body,
    signal: input.signal,
  });
  if (!response.ok) return response;
  const record = typeof response.body === 'object' && response.body !== null
    ? response.body as Readonly<Record<string, unknown>>
    : null;
  const threadId = positiveInteger(record?.id);
  const comments = Array.isArray(record?.comments) ? record.comments : [];
  const first = typeof comments[0] === 'object' && comments[0] !== null
    ? comments[0] as Readonly<Record<string, unknown>>
    : null;
  const commentId = positiveInteger(first?.id);
  return threadId === null || commentId === null
    ? { ok: false, failure: { class: 'malformedResponse', status: response.status, detail: 'Azure DevOps created a thread without a usable thread/comment id.', typeKey: null, retryNotBeforeMs: null, rateLimit: null } }
    : { ok: true, externalRef: `${String(threadId)}:${String(commentId)}` };
}

/** Creates one reply under one exact Azure thread comment. */
export async function createAzurePullRequestThreadReply(input: Readonly<{
  client: AzureDevOpsApiClient;
  address: AzurePullRequestRouteAddress;
  threadId: number;
  parentCommentId: number;
  content: string;
  signal: AbortSignal;
}>): Promise<AzureCreatedCommentOutcomeV1> {
  const response = await input.client.request({
    route: { resource: 'threads', ...input.address, threadId: input.threadId, comments: true },
    method: 'POST',
    body: { content: input.content, parentCommentId: input.parentCommentId, commentType: 1 },
    signal: input.signal,
  });
  if (!response.ok) return response;
  const record = typeof response.body === 'object' && response.body !== null
    ? response.body as Readonly<Record<string, unknown>>
    : null;
  const commentId = positiveInteger(record?.id);
  return commentId === null
    ? { ok: false, failure: { class: 'malformedResponse', status: response.status, detail: 'Azure DevOps created a reply without a usable comment id.', typeKey: null, retryNotBeforeMs: null, rateLimit: null } }
    : { ok: true, externalRef: `${String(input.threadId)}:${String(commentId)}` };
}

/** Casts the authenticated viewer's explicit review verdict. */
export async function setAzurePullRequestReviewerVote(input: Readonly<{
  client: AzureDevOpsApiClient;
  address: AzurePullRequestRouteAddress;
  reviewerId: string;
  vote: 10 | -10;
  signal: AbortSignal;
}>): Promise<AzureWriteOutcomeV1> {
  const response = await input.client.request({
    route: { resource: 'reviewers', ...input.address, reviewerId: input.reviewerId },
    method: 'PUT',
    body: { id: input.reviewerId, vote: input.vote },
    signal: input.signal,
  });
  return response.ok ? { ok: true } : { ok: false, failure: response.failure };
}

/* ------------------------------------------------------------- thread status */

/**
 * One thread's status, as this source reads it.
 *
 * Anything Azure returns that is not one of its documented names — including a thread carrying no
 * status at all — reads as `unknown`. Mapping an unfamiliar value onto `active` would tell a
 * reviewer a state this build does not understand is an open one.
 */
export type AzureObservedThreadStatusV1 = AzureRequestableThreadStatusV1 | 'unknown';

const OBSERVED_THREAD_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'fixed',
  'wontFix',
  'closed',
  'byDesign',
  'pending',
]);

export function readAzureThreadStatus(body: unknown): AzureObservedThreadStatusV1 {
  if (typeof body !== 'object' || body === null) return 'unknown';
  const status = (body as Readonly<{ status?: unknown }>).status;
  if (typeof status !== 'string') return 'unknown';
  return OBSERVED_THREAD_STATUSES.has(status)
    ? status as AzureRequestableThreadStatusV1
    : 'unknown';
}

export type AzureThreadReadOutcomeV1 =
  | Readonly<{ ok: true; status: AzureObservedThreadStatusV1 }>
  | Readonly<{ ok: false; failure: AzureDevOpsFailure }>;

/** `GET …/pullRequests/{id}/threads/{threadId}` — the one thread, not the whole list. */
export async function readAzurePullRequestThread(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    threadId: number;
    signal: AbortSignal;
  }>,
): Promise<AzureThreadReadOutcomeV1> {
  const response = await input.client.request({
    route: {
      resource: 'threads',
      project: input.address.project,
      repositoryId: input.address.repositoryId,
      pullRequestId: input.address.pullRequestId,
      threadId: input.threadId,
    },
    signal: input.signal,
  });
  return response.ok
    ? { ok: true, status: readAzureThreadStatus(response.body) }
    : { ok: false, failure: response.failure };
}

/**
 * `PATCH …/pullRequests/{id}/threads/{threadId}` with `status`, and nothing else.
 *
 * No comment, no thread context, no properties: this write says one thing about one thread, and a
 * field it did not need to send is a field it could silently overwrite.
 */
export async function setAzurePullRequestThreadStatus(
  input: Readonly<{
    client: AzureDevOpsApiClient;
    address: AzurePullRequestRouteAddress;
    threadId: number;
    status: AzureRequestableThreadStatusV1;
    signal: AbortSignal;
  }>,
): Promise<AzureWriteOutcomeV1> {
  const response = await input.client.request({
    route: {
      resource: 'threads',
      project: input.address.project,
      repositoryId: input.address.repositoryId,
      pullRequestId: input.address.pullRequestId,
      threadId: input.threadId,
    },
    method: 'PATCH',
    body: { status: input.status },
    signal: input.signal,
  });
  return response.ok ? { ok: true } : { ok: false, failure: response.failure };
}
