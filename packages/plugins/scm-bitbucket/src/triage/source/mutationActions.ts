import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  parseReviewCommentPublicationPlanV1,
  reviewCommentPublicationTargetMatchesV1,
  validateReviewCommentPublicationClaimAgainstPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import type {
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  createBoundedInvocation,
  settleAtMostOnceProviderWrite,
  type BoundedInvocation,
} from '@happier-dev/triage-sources/runtime';

import {
  createBitbucketFailure,
  type BitbucketTriageFailure,
} from '../failures.js';
import { isBitbucketCommentId } from '../identity.js';
import {
  declineBitbucketPullRequest,
  mergeBitbucketPullRequest,
  readBitbucketMergeTaskStatus,
  readBitbucketCommentResolutionState,
  resolveBitbucketComment,
  unresolveBitbucketComment,
  type BitbucketWriteOutcomeV1,
  type BitbucketMergeTaskStatusOutcomeV1,
} from '../mutations/pullRequestWrites.js';
import {
  publishBitbucketReview,
  publishBitbucketReviewComment,
} from '../mutations/reviewPublication.js';
import { toTriageSourceFailure } from './failures.js';
import {
  admitBitbucketEntryInvocation,
  toBitbucketRuntime,
  type BitbucketEntryRouteV1,
} from './invocationAdmission.js';
import {
  BitbucketCommentResolutionInputV1Schema,
  BitbucketDeclineInputV1Schema,
  BitbucketMergeInputV1Schema,
  BitbucketReviewPublicationInputV1Schema,
  BitbucketReviewCommentCreateInputV1Schema,
  BitbucketReviewCommentReplyInputV1Schema,
  type BitbucketCommentResolutionResultV1,
  type BitbucketMutationResultV1,
  type BitbucketReviewPublicationResultV1,
} from './mutationContracts.js';
import { observeBitbucketEntryWithFacts } from './observeEntry.js';
import type { BitbucketTriageApiClient } from '../apiClient.js';

/**
 * The enabled Bitbucket Cloud pull-request mutation Actions.
 *
 * Each is one exact externally visible write with its own closed input and its own confirming
 * read; there is no generic `mutate({ operation, payload })` and there will not be one
 * (`sources/SCM.md` §3.8).
 *
 * All are declared `surfaces: ['ui']`, and that is the human gate. The gate is
 * **reachability, not a prompt**: omitting `agent` and `mcp` means not one of them is
 * agent-reachable at all — no prompt to approve, no tool to call, no exposure. A danger level
 * alone would only floor an agent invocation to an approval prompt, which is a weaker guarantee
 * than not being reachable. `ui` is the write's whole product reach: this plugin's own mounted
 * detail artifact reaches the daemon as present-user UI authority through the authenticated
 * mounted provenance, while direct plugin code — ActionsService — checks only the `plugin`
 * surface and is refused here.
 *
 * The shape every write here follows is the same three steps:
 *
 * 1. **fresh read** under this Action's host-stamped signal, proving the entry is still the
 *    one the user acted on;
 * 2. **the exact documented native request**, sent once and never retried;
 * 3. **a confirming read**, whose re-observed entity is what comes back — never a bare boolean,
 *    which would force the caller into a second read and therefore a second race.
 */

/** The Action ids the detail surface invokes for a Bitbucket pull-request write. */
export const BITBUCKET_TRIAGE_MUTATION_ACTION_IDS = Object.freeze({
  merge: 'pull-request-merge',
  decline: 'pull-request-decline',
  resolveComment: 'pull-request-comment-resolve',
  unresolveComment: 'pull-request-comment-unresolve',
  submitReview: 'pull-request-submit-review',
  createReviewComment: 'pull-request-review-comment-create',
  replyToReviewComment: 'pull-request-thread-reply',
});

/**
 * This source's own bound on one mutation invocation, end to end.
 *
 * `CONTRACT.md` §5.2 leaves the deadline for an independently invoked source Action to the source:
 * Triage supplies none, and there is no public override. It covers the currentness read, the write,
 * the one merge-task status read and the confirming pull-request read together, because what it
 * protects is one person waiting on one button — not each request separately.
 */
/**
 * Bitbucket's merge "may complete asynchronously, and not at our option". This Action follows the
 * admitted same-origin task location once, then performs its exact pull-request reread. It does not
 * hot-loop or invent a polling cadence; when neither read proves `MERGED`, the answer is `pending`
 * and the UI is never told a queued merge merged.
 */
const INVALID_INPUT = createBitbucketFailure('unsupportedContract', 'mutation-input-invalid');
const INVOCATION_CANCELLED = createBitbucketFailure('cancelled', 'invocation-cancelled');

function unavailable(failure: TriageSourceFailureV1): BitbucketMutationResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/**
 * The caller's host-stamped signal used by the whole Action.
 *
 * The composition itself is the shared forge rule and lives at its one owner; only the duration
 * and the sentence are this source's. Two copies of a `clearTimeout`/`unref` pair is how one of
 * them ends up holding the daemon open for a write nobody is waiting on.
 *
 * A caller may itself supply a `TimeoutError`; the classifier preserves that evidence versus an
 * ordinary cancellation without this source choosing the duration.
 */
function boundMutation(callerSignal: AbortSignal | undefined): BoundedInvocation {
  return createBoundedInvocation({
    callerSignal,
  });
}

type MutationContext = Readonly<{
  client: BitbucketTriageApiClient;
  route: BitbucketEntryRouteV1;
  localRef: TriageSourceEntryLocalRefV1;
  signal: AbortSignal;
}>;

/**
 * Everything both writes do before either of them writes anything.
 *
 * The fresh read is a currentness and permission preflight, not a claim that a client-side read
 * serializes the later write. Where Bitbucket offers no native precondition — and it offers none
 * on either of these routes — the rule is read, compare, refuse *before* writing, with a typed
 * result carrying the currently observed entity. Refusing is correct; racing is not.
 */
async function admitMutation(
  input: Readonly<{
    instance: Parameters<typeof admitBitbucketEntryInvocation>[0]['instance'];
    localRef: TriageSourceEntryLocalRefV1;
  }>,
  context: PluginInvocationContext,
): Promise<
  | Readonly<{ ok: true; context: MutationContext; dispose(): void }>
  | Readonly<{ ok: false; result: BitbucketMutationResultV1 }>
> {
  const bounded = boundMutation(context.signal);
  const runtime = toBitbucketRuntime(context, bounded.signal);
  const admitted = await admitBitbucketEntryInvocation(input, runtime);
  if (!admitted.ok) {
    const deadlineExpired = bounded.signal.aborted
      && (bounded.signal.reason as Readonly<{ name?: unknown }> | null)?.name === 'TimeoutError';
    bounded.dispose();
    return {
      ok: false,
      result: unavailable(deadlineExpired
        ? toTriageSourceFailure(createBitbucketFailure(
          'transient',
          'invocation-deadline-exceeded',
        ))
        : admitted.failure),
    };
  }
  return {
    ok: true,
    dispose: bounded.dispose,
    context: {
      client: admitted.client,
      route: admitted.route,
      localRef: input.localRef,
      signal: bounded.signal,
    },
  };
}

/**
 * Shapes a write that never reached a documented terminal outcome.
 *
 * A `rejected` write is reported with its own reason so `409` and `555` stay the two distinct
 * terminal outcomes Bitbucket documents rather than one generic error; anything else is
 * `unavailable` with the classified failure, and neither is retried.
 */
function shapeUnsettledWrite(
  outcome: Extract<BitbucketWriteOutcomeV1, Readonly<{ kind: 'rejected' | 'failed' }>>,
): BitbucketMutationResultV1 {
  return outcome.kind === 'rejected'
    ? Object.freeze({
      kind: 'rejected' as const,
      reason: outcome.reason,
      failure: toTriageSourceFailure(outcome.failure),
    })
    : unavailable(toTriageSourceFailure(outcome.failure));
}

/**
 * A transient transport/server answer cannot prove that Bitbucket did not apply a dispatched
 * command. Caller cancellation has the same epistemic boundary: the source must stop its work,
 * but it cannot tell the caller that a request which raced that cancellation never reached the
 * forge. Both take the one exact confirming read under the invocation's existing signal; an
 * already-aborted signal fails closed as `uncertain` and never emits a retry.
 *
 * In contrast, authentication, permission, rate-limit, contract and ordinary HTTP failures are a
 * response from Bitbucket that proves this command was refused, so confirming them could turn a
 * later unrelated state change into this Action's success.
 */
function isBitbucketAmbiguousWriteFailure(failure: BitbucketTriageFailure): boolean {
  return failure.class === 'transient' || failure.class === 'cancelled';
}

/* ---------------------------------------------------------- review publication */

/** Publishes one frozen canonical Reviews plan through Bitbucket's ordered write sequence. */
export async function publishBitbucketPullRequestReviewAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketReviewPublicationResultV1> {
  const parsed = BitbucketReviewPublicationInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: 'rejected',
      reason: 'invalid_input',
      failure: toTriageSourceFailure(INVALID_INPUT),
    };
  }
  const request = parsed.data;
  let publicationPlan;
  try {
    publicationPlan = parseReviewCommentPublicationPlanV1(request.publicationPlan);
  } catch {
    return {
      kind: 'rejected',
      reason: 'invalid_input',
      failure: toTriageSourceFailure(INVALID_INPUT),
    };
  }
  if (!publicationTargetsBitbucketRequest(request, publicationPlan)) {
    return {
      kind: 'rejected',
      reason: 'invalid_input',
      failure: toTriageSourceFailure(INVALID_INPUT),
    };
  }

  const admitted = await admitMutation(
    { instance: request.instance, localRef: request.localRef },
    context,
  );
  if (!admitted.ok) {
    return {
      kind: 'rejected',
      reason: 'admission_failed',
      ...('failure' in admitted.result ? { failure: admitted.result.failure } : {}),
    };
  }
  const mutation = admitted.context;
  try {
    return await publishBitbucketReview({
      plan: publicationPlan,
      claim: async () => await context.services.actions.execute(
        'reviews.comments.claimPublicationDispatch',
        publicationPlan,
        { signal: mutation.signal },
      ).then((claim) => validateReviewCommentPublicationClaimAgainstPlanV1(
        publicationPlan,
        claim,
      )),
    }, {
      client: mutation.client,
      route: mutation.route,
      signal: mutation.signal,
      observe: async () => await observeBitbucketEntryWithFacts(mutation),
      toTriageFailure: toTriageSourceFailure,
    });
  } finally {
    admitted.dispose();
  }
}

function publicationTargetsBitbucketRequest(
  request: Readonly<{
    instance: { binding: { account: { accountId: string } } };
    localRef: TriageSourceEntryLocalRefV1;
  }>,
  publicationPlan: ReturnType<typeof parseReviewCommentPublicationPlanV1>,
  expectedSubtarget: ReturnType<typeof parseReviewCommentPublicationPlanV1>['target']['subtarget'] = null,
): boolean {
  return reviewCommentPublicationTargetMatchesV1(publicationPlan.target, {
    providerId: 'bitbucket',
    configuredAccountId: request.instance.binding.account.accountId,
    sourceId: 'happier.scm.forge.bitbucket/bitbucket-forge',
    localRef: request.localRef,
    subtarget: expectedSubtarget,
  });
}

async function publishBitbucketSingleReviewComment(
  request: Readonly<{
    instance: Parameters<typeof admitMutation>[0]['instance'];
    localRef: TriageSourceEntryLocalRefV1;
  }>,
  publicationPlan: ReturnType<typeof parseReviewCommentPublicationPlanV1>,
  mode: Readonly<{ kind: 'create' } | { kind: 'reply'; parentCommentId: string }>,
  context: PluginInvocationContext,
): Promise<BitbucketReviewPublicationResultV1> {
  const admitted = await admitMutation(
    { instance: request.instance, localRef: request.localRef },
    context,
  );
  if (!admitted.ok) return {
    kind: 'rejected',
    reason: 'admission_failed',
    ...('failure' in admitted.result ? { failure: admitted.result.failure } : {}),
  };
  const mutation = admitted.context;
  try {
    return await publishBitbucketReviewComment({
      plan: publicationPlan,
      mode,
      claim: async () => await context.services.actions.execute(
        'reviews.comments.claimPublicationDispatch', publicationPlan, { signal: mutation.signal },
      ).then((claim) => validateReviewCommentPublicationClaimAgainstPlanV1(publicationPlan, claim)),
    }, {
      client: mutation.client,
      route: mutation.route,
      signal: mutation.signal,
      observe: async () => await observeBitbucketEntryWithFacts(mutation),
      toTriageFailure: toTriageSourceFailure,
    });
  } finally { admitted.dispose(); }
}

/** Publishes one canonical proposal at one exact pinned Bitbucket diff anchor. */
export async function createBitbucketPullRequestReviewCommentAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketReviewPublicationResultV1> {
  const parsed = BitbucketReviewCommentCreateInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  const request = parsed.data;
  let publicationPlan;
  try { publicationPlan = parseReviewCommentPublicationPlanV1(request.publicationPlan); } catch {
    return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  }
  if (!publicationTargetsBitbucketRequest(request, publicationPlan)) {
    return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  }
  return await publishBitbucketSingleReviewComment(
    request,
    publicationPlan,
    { kind: 'create' },
    context,
  );
}

/** Publishes one canonical proposal beneath one exact existing Bitbucket comment. */
export async function replyToBitbucketPullRequestReviewCommentAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketReviewPublicationResultV1> {
  const parsed = BitbucketReviewCommentReplyInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  const request = parsed.data;
  if (!isBitbucketCommentId(request.parentCommentId)) {
    return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  }
  let publicationPlan;
  try { publicationPlan = parseReviewCommentPublicationPlanV1(request.publicationPlan); } catch {
    return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  }
  if (!publicationTargetsBitbucketRequest(request, publicationPlan, {
    kindId: 'review-comment',
    targetId: request.parentCommentId,
  })) {
    return { kind: 'rejected', reason: 'invalid_input', failure: toTriageSourceFailure(INVALID_INPUT) };
  }
  return await publishBitbucketSingleReviewComment(
    request,
    publicationPlan,
    { kind: 'reply', parentCommentId: request.parentCommentId },
    context,
  );
}

/* --------------------------------------------------------------------- merge */

/**
 * `bitbucket/pull-request/merge` — irreversible on the forge, and pinned to the head the user saw.
 *
 * Bitbucket's merge endpoint publishes no expected-head parameter, so the pin is enforced here by
 * reading, comparing and refusing before the write. The pinned value is never filled from that
 * fresh read: its whole value is that it comes from the read the **user** acted on, and a merge
 * that quietly lands a commit pushed after they clicked is the failure this prevents.
 *
 * Merge owns exactly one external effect: the merge. `close_source_branch` is Bitbucket's own
 * parameter for the branch decision and travels inside that one request, so there is no follow-up
 * source-ref delete whose read-before-delete could not close the window in which a collaborator
 * pushed.
 */
export async function mergeBitbucketPullRequestAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketMutationResultV1> {
  const parsed = BitbucketMergeInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;

  const admitted = await admitMutation(
    { instance: request.instance, localRef: request.localRef },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.context;
  try {

  const current = await observeBitbucketEntryWithFacts(mutation);
  if (current.observation.kind !== 'present') {
    return unavailable(
      current.observation.kind === 'unresolved'
        ? current.observation.failure
        : toTriageSourceFailure(INVALID_INPUT),
    );
  }
  if (current.state !== 'OPEN') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-open' as const,
      observation: current.observation,
    });
  }
  if (current.headCommit === null || current.headCommit !== request.observedHeadCommit) {
    // Zero writes. The host re-renders against the head this read observed and the user decides
    // again about the commits that are actually there; an automatic retry would re-decide for them.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'head-advanced' as const,
      observation: current.observation,
    });
  }

  let dispatched: BitbucketWriteOutcomeV1 | null = null;
  let queuedTask: BitbucketMergeTaskStatusOutcomeV1 | null = null;
  const write = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      dispatched = await mergeBitbucketPullRequest({
        client: mutation.client,
        route: mutation.route,
        parameters: {
          closeSourceBranch: request.closeSourceBranch,
          mergeStrategy: request.mergeStrategy,
          ...(request.message === undefined ? {} : { message: request.message }),
        },
        signal: mutation.signal,
      });
      return dispatched;
    },
    mayHaveChanged: (result) => result.kind === 'succeeded'
      || result.kind === 'queued'
      || (result.kind === 'failed' && isBitbucketAmbiguousWriteFailure(result.failure)),
    confirm: async () => {
      const queued = dispatched?.kind === 'queued' ? dispatched : null;
      if (queued !== null) {
        queuedTask = await readBitbucketMergeTaskStatus({
          client: mutation.client,
          statusUrl: queued.statusUrl,
          signal: mutation.signal,
        });
      }
      const confirmed = await observeBitbucketEntryWithFacts(mutation);
      if (confirmed.state === 'MERGED') {
        return { kind: 'applied' as const, observation: confirmed.observation };
      }
      if (confirmed.observation.kind === 'unresolved') {
        return { kind: 'uncertain' as const, failure: confirmed.observation.failure };
      }
      if (queuedTask?.kind === 'failed') {
        return {
          kind: 'uncertain' as const,
          observation: confirmed.observation,
          failure: queuedTask.failure,
        };
      }
      return dispatched?.kind === 'queued' && confirmed.state === 'OPEN'
        ? { kind: 'uncertain' as const, observation: confirmed.observation }
        : { kind: 'unchanged' as const, observation: confirmed.observation };
    },
  });
  // TypeScript does not model assignments made inside the confirmation callback when it
  // narrows a local after the awaited higher-order call. Keep the exact callback-owned outcome,
  // but restore its declared union at this boundary before shaping the public result.
  const queuedTaskOutcome = queuedTask as BitbucketMergeTaskStatusOutcomeV1 | null;
  if (queuedTaskOutcome?.kind === 'rejected') {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'provider-rejected' as const,
      failure: toTriageSourceFailure(queuedTaskOutcome.failure),
    });
  }
  if (write.kind === 'settled') {
    return write.result.kind === 'rejected' || write.result.kind === 'failed'
      ? shapeUnsettledWrite(write.result)
      : unavailable(toTriageSourceFailure(INVOCATION_CANCELLED));
  }
  if (write.kind === 'applied') {
    return Object.freeze({ kind: 'applied' as const, observation: write.observation });
  }
  if (write.kind === 'unchanged') {
    const dispatchedOutcome = dispatched as BitbucketWriteOutcomeV1 | null;
    if (
      dispatchedOutcome?.kind === 'failed'
      && isBitbucketAmbiguousWriteFailure(dispatchedOutcome.failure)
    ) {
      return Object.freeze({
        kind: 'uncertain' as const,
        observation: write.observation,
        failure: toTriageSourceFailure(dispatchedOutcome.failure),
      });
    }
    return Object.freeze({ kind: 'unchanged' as const, observation: write.observation });
  }
  const dispatchedOutcome = dispatched as BitbucketWriteOutcomeV1 | null;
  if (dispatchedOutcome?.kind === 'queued' && write.observation !== undefined) {
    return Object.freeze({ kind: 'pending' as const, observation: write.observation });
  }
  return Object.freeze({
    kind: 'uncertain' as const,
    ...(write.observation === undefined ? {} : { observation: write.observation }),
    ...(write.failure === undefined ? {} : { failure: toTriageSourceFailure(write.failure) }),
  });
  } finally {
    admitted.dispose();
  }
}

/* ------------------------------------------------------------------- decline */

/**
 * `bitbucket/pull-request/decline` — Bitbucket's own word for closing a pull request.
 *
 * It carries no head pin: declining is head-independent, and a pin would add a failure mode
 * protecting no invariant. It is reported as its own Action rather than as "close" because
 * Bitbucket has **no reopen at all** — the state enum is `OPEN | MERGED | DECLINED | SUPERSEDED`
 * and a declined pull request cannot be revived through REST. Calling it "close" would imply an
 * undo this forge does not have.
 */
export async function declineBitbucketPullRequestAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketMutationResultV1> {
  const parsed = BitbucketDeclineInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;

  const admitted = await admitMutation(
    { instance: request.instance, localRef: request.localRef },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.context;
  try {

  if (mutation.signal.aborted) return unavailable(toTriageSourceFailure(INVOCATION_CANCELLED));

  const current = await observeBitbucketEntryWithFacts(mutation);
  if (current.observation.kind !== 'present') {
    return unavailable(
      current.observation.kind === 'unresolved'
        ? current.observation.failure
        : toTriageSourceFailure(INVALID_INPUT),
    );
  }
  if (current.state !== 'OPEN') {
    // Already declined, merged or superseded. Declining again is not a converging no-op on this
    // forge — a merged pull request must not be reported as declined — so it is refused with the
    // state that made it inapplicable.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-open' as const,
      observation: current.observation,
    });
  }

  let dispatched: BitbucketWriteOutcomeV1 | null = null;
  const write = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      dispatched = await declineBitbucketPullRequest({
        client: mutation.client,
        route: mutation.route,
        signal: mutation.signal,
      });
      return dispatched;
    },
    mayHaveChanged: (result) => result.kind === 'succeeded'
      || (result.kind === 'failed' && isBitbucketAmbiguousWriteFailure(result.failure)),
    confirm: async () => {
      const confirmed = await observeBitbucketEntryWithFacts(mutation);
      if (confirmed.state === 'DECLINED') {
        return { kind: 'applied' as const, observation: confirmed.observation };
      }
      if (confirmed.observation.kind === 'unresolved') {
        return { kind: 'uncertain' as const, failure: confirmed.observation.failure };
      }
      return { kind: 'unchanged' as const, observation: confirmed.observation };
    },
  });
  if (write.kind === 'settled') {
    return write.result.kind === 'rejected' || write.result.kind === 'failed'
      ? shapeUnsettledWrite(write.result)
      : unavailable(toTriageSourceFailure(INVOCATION_CANCELLED));
  }
  if (write.kind === 'applied') return Object.freeze({ kind: 'applied' as const, observation: write.observation });
  if (write.kind === 'unchanged') {
    const dispatchedOutcome = dispatched as BitbucketWriteOutcomeV1 | null;
    if (
      dispatchedOutcome?.kind === 'failed'
      && isBitbucketAmbiguousWriteFailure(dispatchedOutcome.failure)
    ) {
      return Object.freeze({
        kind: 'uncertain' as const,
        observation: write.observation,
        failure: toTriageSourceFailure(dispatchedOutcome.failure),
      });
    }
    return Object.freeze({ kind: 'unchanged' as const, observation: write.observation });
  }
  return Object.freeze({
    kind: 'uncertain' as const,
    ...(write.observation === undefined ? {} : { observation: write.observation }),
    ...(write.failure === undefined ? {} : { failure: toTriageSourceFailure(write.failure) }),
  });
  } finally {
    admitted.dispose();
  }
}

/* --------------------------------------------------------- comment resolution */

/**
 * `bitbucket/pull-request/comment-resolution` and `bitbucket/pull-request/comment-unresolution`.
 *
 * One route, two verbs: Bitbucket documents `POST …/comments/{id}/resolve` as *resolve a comment
 * thread* and `DELETE` on that same path as *reopen a comment thread*. The two Actions run through
 * this one body because everything except the verb and the target resolution is identical, and two
 * copies would be two answers to what a resolved thread is.
 *
 * Neither gates on the pull request's state, and that is deliberate. Merge and decline are
 * transitions of an OPEN pull request; resolving a review thread is not — people resolve stale
 * threads on merged and declined pull requests, Bitbucket lets them, and refusing here would take
 * away a capability the forge has for a symmetry nothing needs.
 *
 * The pre-write read is a currentness proof, not a lock: a comment that already reads the way the
 * caller asked for is refused rather than written, because such a write's only possible effect is
 * a race with somebody else's change.
 */
async function runBitbucketCommentResolution(
  input: unknown,
  context: PluginInvocationContext,
  target: 'resolved' | 'unresolved',
): Promise<BitbucketCommentResolutionResultV1> {
  const parsed = BitbucketCommentResolutionInputV1Schema.safeParse(input);
  if (!parsed.success) return commentUnavailable(toTriageSourceFailure(INVALID_INPUT));
  const request = parsed.data;
  // The grammar is checked before the route exists: a comment id this source could not have minted
  // must never become a path segment a credential is sent to.
  if (!isBitbucketCommentId(request.commentId)) {
    return commentUnavailable(toTriageSourceFailure(INVALID_INPUT));
  }

  const admitted = await admitMutation(
    { instance: request.instance, localRef: request.localRef },
    context,
  );
  if (!admitted.ok) {
    return commentUnavailable(
      admitted.result.kind === 'unavailable'
        ? admitted.result.failure
        : toTriageSourceFailure(INVALID_INPUT),
    );
  }
  const mutation = admitted.context;
  try {

  if (mutation.signal.aborted) {
    return commentUnavailable(toTriageSourceFailure(INVOCATION_CANCELLED));
  }

  const current = await readBitbucketCommentResolutionState({
    client: mutation.client,
    route: mutation.route,
    commentId: request.commentId,
    signal: mutation.signal,
  });
  if (!current.ok) return commentUnavailable(toTriageSourceFailure(current.failure));
  if (current.resolution === target) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'already-in-resolution' as const,
      resolution: current.resolution,
    });
  }
  // `unknown` does NOT refuse. A deployment that omits the field said nothing about this thread,
  // and treating silence as "already that way" would remove the write from every deployment whose
  // responses this build cannot read the resolution out of. The confirming read below still has to
  // prove the effect.

  let dispatched: BitbucketWriteOutcomeV1 | null = null;
  const write = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      dispatched = target === 'resolved'
        ? await resolveBitbucketComment({
        client: mutation.client,
        route: mutation.route,
        commentId: request.commentId,
        signal: mutation.signal,
      })
        : await unresolveBitbucketComment({
        client: mutation.client,
        route: mutation.route,
        commentId: request.commentId,
        signal: mutation.signal,
      });
      return dispatched;
    },
    mayHaveChanged: (result) => result.kind === 'succeeded'
      || (result.kind === 'failed' && isBitbucketAmbiguousWriteFailure(result.failure)),
    confirm: async () => {
      const confirmed = await readBitbucketCommentResolutionState({
        client: mutation.client,
        route: mutation.route,
        commentId: request.commentId,
        signal: mutation.signal,
      });
      if (!confirmed.ok) return { kind: 'uncertain' as const, failure: confirmed.failure };
      if (confirmed.resolution === target) {
        return { kind: 'applied' as const, observation: confirmed.resolution };
      }
      return confirmed.resolution === 'unknown'
        ? { kind: 'uncertain' as const, observation: confirmed.resolution }
        : { kind: 'unchanged' as const, observation: confirmed.resolution };
    },
  });
  if (write.kind === 'settled') {
    return write.result.kind === 'failed'
      ? commentUnavailable(toTriageSourceFailure(write.result.failure))
      : Object.freeze({ kind: 'uncertain' as const });
  }
  if (write.kind === 'applied') {
    return Object.freeze({ kind: 'applied' as const, resolution: write.observation });
  }
  if (write.kind === 'unchanged') {
    const dispatchedOutcome = dispatched as BitbucketWriteOutcomeV1 | null;
    if (dispatchedOutcome?.kind === 'succeeded') {
      return Object.freeze({
        kind: 'rejected' as const,
        reason: 'resolution-unconfirmed' as const,
        resolution: write.observation,
      });
    }
    if (
      dispatchedOutcome?.kind === 'failed'
      && isBitbucketAmbiguousWriteFailure(dispatchedOutcome.failure)
    ) {
      return Object.freeze({
        kind: 'uncertain' as const,
        resolution: write.observation,
        failure: toTriageSourceFailure(dispatchedOutcome.failure),
      });
    }
    return Object.freeze({ kind: 'unchanged' as const, resolution: write.observation });
  }
  const dispatchedOutcome = dispatched as BitbucketWriteOutcomeV1 | null;
  if (dispatchedOutcome?.kind === 'succeeded' && write.observation !== undefined) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'resolution-unconfirmed' as const,
      resolution: write.observation,
    });
  }
  return Object.freeze({
    kind: 'uncertain' as const,
    ...(write.observation === undefined ? {} : { resolution: write.observation }),
    ...(write.failure === undefined ? {} : { failure: toTriageSourceFailure(write.failure) }),
  });
  } finally {
    admitted.dispose();
  }
}

function commentUnavailable(failure: TriageSourceFailureV1): BitbucketCommentResolutionResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/** `bitbucket/pull-request/comment-resolution` — Bitbucket's resolve. */
export async function resolveBitbucketCommentAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketCommentResolutionResultV1> {
  return runBitbucketCommentResolution(input, context, 'resolved');
}

/** `bitbucket/pull-request/comment-unresolution` — Bitbucket's reopen, on the same path. */
export async function unresolveBitbucketCommentAction(
  input: unknown,
  context: PluginInvocationContext,
): Promise<BitbucketCommentResolutionResultV1> {
  return runBitbucketCommentResolution(input, context, 'unresolved');
}
