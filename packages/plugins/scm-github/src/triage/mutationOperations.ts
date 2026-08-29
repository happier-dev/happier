import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  parseReviewCommentPublicationPlanV1,
  reviewCommentPublicationTargetMatchesV1,
  validateReviewCommentPublicationClaimAgainstPlanV1,
  type ReviewCommentPublicationPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';


import { admitGithubEntryInvocation } from './admission.js';
import {
  GithubIssueAssigneeAddInputV1Schema,
  GithubIssueAssigneeRemoveInputV1Schema,
  GithubIssueCloseInputV1Schema,
  GithubIssueCommentInputV1Schema,
  GithubIssueLabelAddInputV1Schema,
  GithubIssueLabelRemoveInputV1Schema,
  GithubIssueReopenInputV1Schema,
  GithubPullRequestAddReviewersInputV1Schema,
  GithubPullRequestCloseInputV1Schema,
  GithubPullRequestMarkReadyInputV1Schema,
  GithubPullRequestMergeInputV1Schema,
  GithubPullRequestReviewPublicationInputV1Schema,
  GithubPullRequestReviewCommentCreateInputV1Schema,
  GithubPullRequestRemoveReviewersInputV1Schema,
  GithubPullRequestReopenInputV1Schema,
  GithubPullRequestThreadResolutionInputV1Schema,
  GithubPullRequestThreadReplyInputV1Schema,
  GithubPullRequestUpdateBranchInputV1Schema,
  type GithubIssueDeltaResultV1,
  type GithubPullRequestMarkReadyResultV1,
  type GithubPullRequestMergeResultV1,
  type GithubPullRequestReviewersResultV1,
  type GithubPullRequestStateResultV1,
  type GithubPullRequestThreadResolutionResultV1,
  type GithubPullRequestUpdateBranchResultV1,
  type GithubPullRequestReviewPublicationInputV1,
} from './mutations/contracts.js';
import {
  addGithubIssueAssignees,
  addGithubIssueLabels,
  closeGithubIssue,
  publishGithubIssueComment,
  removeGithubIssueAssignees,
  removeGithubIssueLabel,
  reopenGithubIssue,
} from './mutations/issue.js';
import {
  closeGithubPullRequest,
  markGithubPullRequestReady,
  mergeGithubPullRequest,
  publishGithubPullRequestReview,
  publishGithubPullRequestComment,
  reopenGithubPullRequest,
  updateGithubPullRequestBranch,
} from './mutations/pullRequest.js';
import {
  removeGithubPullRequestReviewers,
  requestGithubPullRequestReviewers,
} from './mutations/reviewers.js';
import { setGithubReviewThreadResolution } from './mutations/reviewThread.js';

function publicationPlanTargetsRequest(
  request: Pick<GithubPullRequestReviewPublicationInputV1, 'instance' | 'localRef'>,
  plan: ReviewCommentPublicationPlanV1,
  expectedSubtarget: ReviewCommentPublicationPlanV1['target']['subtarget'] = null,
): boolean {
  return reviewCommentPublicationTargetMatchesV1(plan.target, {
    providerId: 'github',
    configuredAccountId: request.instance.binding.account.accountId,
    sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
    localRef: request.localRef,
    subtarget: expectedSubtarget,
  });
}

async function claimPublicationPlan(
  plan: ReviewCommentPublicationPlanV1,
  signal: AbortSignal,
  context: PluginInvocationContext,
) {
  const claim = await context.services.actions.execute(
    'reviews.comments.claimPublicationDispatch',
    plan,
    { signal },
  );
  return validateReviewCommentPublicationClaimAgainstPlanV1(plan, claim);
}

/**
 * The bound GitHub pull-request mutation Actions.
 *
 * Each is the whole vertical for ONE exact externally visible write. It validates
 * its own strict published input, admits the configured instance through the SAME
 * rule every read uses, resolves the route from current source evidence,
 * rematerializes that exact account inside one request closure, rereads the
 * provider entity before any effect, and returns the re-observed entity.
 *
 * They are declared `surfaces: ['ui']`, and the ABSENCE of `agent` and
 * `mcp` is the human gate: an agent cannot reach them at all — no prompt to
 * approve, no tool, no exposure. There is no list of exempted callers here and
 * none may be added. `ui` is the write's whole product reach: the daemon
 * derives the invoking surface from the authenticated mounted-UI provenance,
 * so this source's own mounted detail body reaches each write as present-user
 * authority while direct plugin code — ActionsService — checks only the
 * `plugin` surface and is refused here; nothing between the press and the
 * provider write is shared mutable state. There is no queue, no receipt, no
 * lease, no in-flight registry, and no retry timer: an ambiguous outcome is
 * reported as uncertain and the user decides, because a retry would re-decide
 * on their behalf against state they never saw.
 */

const INVALID_INPUT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_mutation_input_invalid',
});

function failed(failure: TriageSourceFailureV1): Readonly<{
  kind: 'failed';
  failure: TriageSourceFailureV1;
}> {
  return Object.freeze({ kind: 'failed' as const, failure });
}

/**
 * The cross-field rule both reviewer deltas carry: `users` and `teams` are
 * independently optional and at least one must name somebody.
 *
 * "At least one of two optional fields" is a rule no single field schema can
 * express, so it lives here — before any admission, and therefore before any
 * outbound call. `null` means the request named nobody, which is rejected rather
 * than turned into a request for nobody.
 */
function namedReviewers(
  request: Readonly<{ users?: readonly string[]; teams?: readonly string[] }>,
): Readonly<{ users: readonly string[]; teams: readonly string[] }> | null {
  const users = request.users ?? [];
  const teams = request.teams ?? [];
  return users.length === 0 && teams.length === 0
    ? null
    : Object.freeze({ users, teams });
}

/**
 * Merges one pull request at the exact head the user acted on.
 *
 * The pinned head is passed straight to GitHub's own `sha` precondition and is
 * also compared against the fresh read: a head that moved refuses with the
 * currently observed entity and ZERO writes.
 */
export async function mergeGithubPullRequestAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestMergeResultV1> {
  const parsed = GithubPullRequestMergeInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    // An issue has no head, no merge and no mergeability. Answering for one would
    // be a different claim from "this write does not apply to this kind".
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await mergeGithubPullRequest({
    localRef: admitted.localRef,
    route: admitted.route,
    headRevision: request.headRevision,
    mergeMethod: request.mergeMethod,
    ...(request.commitTitle === undefined ? {} : { commitTitle: request.commitTitle }),
    ...(request.commitMessage === undefined ? {} : { commitMessage: request.commitMessage }),
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/** Publishes one canonical multi-comment plan through GitHub's single review endpoint. */
export async function publishGithubPullRequestReviewAction(
  input: unknown,
  context: PluginInvocationContext,
) {
  const parsed = GithubPullRequestReviewPublicationInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'invalid_input' as const,
      failure: INVALID_INPUT_FAILURE,
    });
  }
  const request = parsed.data;
  let publicationPlan;
  try {
    publicationPlan = parseReviewCommentPublicationPlanV1(request.publicationPlan);
  } catch {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'invalid_input' as const,
      failure: INVALID_INPUT_FAILURE,
    });
  }
  if (!publicationPlanTargetsRequest(request, publicationPlan)) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'invalid_input' as const,
      failure: INVALID_INPUT_FAILURE,
    });
  }
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'admission_failed' as const,
      failure: admitted.failure,
    });
  }
  return await publishGithubPullRequestReview({
    localRef: admitted.localRef,
    route: admitted.route,
    publicationPlan,
    claimPublicationDispatch: async () => await claimPublicationPlan(
      publicationPlan, admitted.signal, context,
    ),
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

async function parsePublicationPlanOrReject(value: unknown): Promise<ReviewCommentPublicationPlanV1 | null> {
  try {
    return parseReviewCommentPublicationPlanV1(value);
  } catch {
    return null;
  }
}

/** Publishes one pinned canonical proposal as a standalone review comment. */
export async function createGithubPullRequestReviewCommentAction(
  input: unknown,
  context: PluginInvocationContext,
) {
  const parsed = GithubPullRequestReviewCommentCreateInputV1Schema.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  const request = parsed.data;
  const publicationPlan = await parsePublicationPlanOrReject(request.publicationPlan);
  if (publicationPlan === null || !publicationPlanTargetsRequest(request, publicationPlan)) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  }
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return Object.freeze({ kind: 'rejected' as const, reason: 'admission_failed' as const, failure: admitted.failure });
  return await publishGithubPullRequestComment({
    localRef: admitted.localRef,
    route: admitted.route,
    publicationPlan,
    mode: 'create',
    claimPublicationDispatch: async () => await claimPublicationPlan(publicationPlan, admitted.signal, context),
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/** Publishes one canonical proposal as a reply to one exact GraphQL review thread. */
export async function replyToGithubPullRequestThreadAction(
  input: unknown,
  context: PluginInvocationContext,
) {
  const parsed = GithubPullRequestThreadReplyInputV1Schema.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  const request = parsed.data;
  const publicationPlan = await parsePublicationPlanOrReject(request.publicationPlan);
  if (publicationPlan === null || !publicationPlanTargetsRequest(request, publicationPlan, {
    kindId: 'review-thread',
    targetId: request.threadId,
  })) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  }
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return Object.freeze({ kind: 'rejected' as const, reason: 'admission_failed' as const, failure: admitted.failure });
  return await publishGithubPullRequestComment({
    localRef: admitted.localRef,
    route: admitted.route,
    publicationPlan,
    mode: 'reply',
    threadId: request.threadId,
    claimPublicationDispatch: async () => await claimPublicationPlan(publicationPlan, admitted.signal, context),
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/** Publishes one canonical proposal into one exact issue conversation. */
export async function createGithubIssueCommentAction(
  input: unknown,
  context: PluginInvocationContext,
) {
  const parsed = GithubIssueCommentInputV1Schema.safeParse(input);
  if (!parsed.success) return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  const request = parsed.data;
  const publicationPlan = await parsePublicationPlanOrReject(request.publicationPlan);
  if (publicationPlan === null || !publicationPlanTargetsRequest(request, publicationPlan)) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const, failure: INVALID_INPUT_FAILURE });
  }
  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return Object.freeze({ kind: 'rejected' as const, reason: 'admission_failed' as const, failure: admitted.failure });
  return await publishGithubIssueComment({
    localRef: admitted.localRef,
    route: admitted.route,
    publicationPlan,
    claimPublicationDispatch: async () => await claimPublicationPlan(publicationPlan, admitted.signal, context),
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/** Closes one open pull request, leaving its branch and commits untouched. */
export async function closeGithubPullRequestAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestStateResultV1> {
  const parsed = GithubPullRequestCloseInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await closeGithubPullRequest(
    { localRef: admitted.localRef, route: admitted.route },
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );
}

/** Reopens one closed, unmerged pull request. */
export async function reopenGithubPullRequestAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestStateResultV1> {
  const parsed = GithubPullRequestReopenInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await reopenGithubPullRequest(
    { localRef: admitted.localRef, route: admitted.route },
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );
}

/**
 * Marks one draft pull request ready for review at the exact head the user saw.
 *
 * GitHub publishes no precondition for this transition, so the pin is enforced
 * here by read-compare-refuse: a head that moved refuses with the currently
 * observed entity and ZERO writes. The write's effect IS a notification fan-out,
 * and against a stale head it summons reviewers to code the user never saw.
 */
export async function markGithubPullRequestReadyAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestMarkReadyResultV1> {
  const parsed = GithubPullRequestMarkReadyInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await markGithubPullRequestReady({
    localRef: admitted.localRef,
    route: admitted.route,
    headRevision: request.headRevision,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/**
 * Updates one pull request's branch from its base, at the exact head the user saw.
 *
 * The pin is both compared against the fresh read and handed to GitHub's own
 * `expected_head_sha`. GitHub's `202` means it accepted the request, so an
 * accepted update the confirming read cannot yet observe settles as `pending`
 * rather than as success.
 */
export async function updateGithubPullRequestBranchAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestUpdateBranchResultV1> {
  const parsed = GithubPullRequestUpdateBranchInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await updateGithubPullRequestBranch({
    localRef: admitted.localRef,
    route: admitted.route,
    headRevision: request.headRevision,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/**
 * Requests review from exactly the named users and/or teams.
 *
 * `users` and `teams` are independently optional and at least one must carry a
 * name: "at least one of two optional fields" is a cross-field rule no single
 * field schema can express, so it is enforced here — before any admission, and
 * therefore before any outbound call. An empty request is rejected rather than
 * turned into a request for nobody.
 */
export async function addGithubPullRequestReviewersAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestReviewersResultV1> {
  const parsed = GithubPullRequestAddReviewersInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const named = namedReviewers(request);
  if (named === null) return failed(INVALID_INPUT_FAILURE);

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await requestGithubPullRequestReviewers(
    { localRef: admitted.localRef, route: admitted.route, ...named },
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );
}

/**
 * Withdraws the review request from exactly the named users and/or teams.
 *
 * It is a separate Action from the addition rather than a direction field on it,
 * because the manifest is what classifies, confirms and describes a write. The
 * cross-field non-empty rule is the same one the addition enforces, and it is
 * enforced through the same helper so the two cannot drift into "one of them
 * accepts a request for nobody".
 */
export async function removeGithubPullRequestReviewersAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestReviewersResultV1> {
  const parsed = GithubPullRequestRemoveReviewersInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;
  const named = namedReviewers(request);
  if (named === null) return failed(INVALID_INPUT_FAILURE);

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await removeGithubPullRequestReviewers(
    { localRef: admitted.localRef, route: admitted.route, ...named },
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );
}

/**
 * Resolves or reopens one line-anchored review thread on this pull request.
 *
 * `resolved` is the state the caller wants, not a verb, which is what makes this
 * ONE idempotent Action rather than two: a second call converges on the same
 * state instead of creating a second object. Both directions exist because both
 * are real — a thread resolved by mistake has to be reopenable.
 *
 * The admitted route and entry are not decoration here. A thread node id is
 * opaque and GLOBAL, so the Action's own read proves the thread hangs on THIS
 * pull request before anything is written, and a thread on another entry or
 * another repository is refused with zero mutations.
 */
export async function setGithubPullRequestThreadResolutionAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestThreadResolutionResultV1> {
  const parsed = GithubPullRequestThreadResolutionInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    // A review thread hangs on a pull request's diff. An issue has none, so this
    // write does not apply to one at all.
    admissibleKinds: ['pull-request'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await setGithubReviewThreadResolution({
    localRef: admitted.localRef,
    route: admitted.route,
    threadId: request.threadId,
    resolved: request.resolved,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/* --------------------------------------------------------------- issue writes */

/**
 * The bound GitHub ISSUE mutation Actions.
 *
 * They admit `issue` and only `issue`. A pull request is an issue to some of
 * GitHub's own endpoints, but these writes are offered on an issue and answer for
 * an issue — closing a pull request through the issue transition would skip the
 * merged/state reasoning the pull-request Action owns, so the kind is refused
 * before any outbound call rather than quietly served.
 *
 * None carries a head pin. An issue has no head, so pinning one would add a
 * failure mode protecting no invariant.
 */

/**
 * Closes one open issue with the reason the caller chose.
 *
 * `stateReason` is required by the published input and is never defaulted here.
 * GitHub shows "closed as completed" and "closed as not planned" differently to
 * everyone watching the issue, so choosing one publishes a claim the person did
 * not make.
 */
export async function closeGithubIssueAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestStateResultV1> {
  const parsed = GithubIssueCloseInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await closeGithubIssue({
    localRef: admitted.localRef,
    route: admitted.route,
    stateReason: request.stateReason,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/** Reopens one closed issue. GitHub owns the `reopened` reason itself. */
export async function reopenGithubIssueAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubPullRequestStateResultV1> {
  const parsed = GithubIssueReopenInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await reopenGithubIssue(
    { localRef: admitted.localRef, route: admitted.route },
    { client: admitted.client, now: Date.now, signal: admitted.signal },
  );
}

/**
 * The four exact issue deltas.
 *
 * Each validates its own strict published input — non-empty, unique, and for
 * assignees at most the ten GitHub itself accepts — and then dispatches GitHub's
 * own native add/remove endpoint. None of them can express a desired full set,
 * so a concurrent unrelated addition is never silently dropped.
 */
export async function addGithubIssueAssigneesAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubIssueDeltaResultV1> {
  const parsed = GithubIssueAssigneeAddInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await addGithubIssueAssignees({
    localRef: admitted.localRef,
    route: admitted.route,
    usernames: request.usernames,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

export async function removeGithubIssueAssigneesAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubIssueDeltaResultV1> {
  const parsed = GithubIssueAssigneeRemoveInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await removeGithubIssueAssignees({
    localRef: admitted.localRef,
    route: admitted.route,
    usernames: request.usernames,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

export async function addGithubIssueLabelsAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubIssueDeltaResultV1> {
  const parsed = GithubIssueLabelAddInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await addGithubIssueLabels({
    localRef: admitted.localRef,
    route: admitted.route,
    labels: request.labels,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}

/**
 * Removes exactly ONE label, because GitHub's native single-label delete is
 * single-label. The alternatives replace or clear the whole set, which is
 * authority this Action does not have.
 */
export async function removeGithubIssueLabelAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GithubIssueDeltaResultV1> {
  const parsed = GithubIssueLabelRemoveInputV1Schema.safeParse(input);
  if (!parsed.success) return failed(INVALID_INPUT_FAILURE);
  const request = parsed.data;

  const admitted = await admitGithubEntryInvocation({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    admissibleKinds: ['issue'],
  }, context);
  if (!admitted.ok) return failed(admitted.failure);

  return await removeGithubIssueLabel({
    localRef: admitted.localRef,
    route: admitted.route,
    label: request.label,
  }, { client: admitted.client, now: Date.now, signal: admitted.signal });
}
