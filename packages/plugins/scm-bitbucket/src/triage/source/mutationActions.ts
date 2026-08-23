import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type {
  TriageSourceEntryLocalRefV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { createBitbucketFailure } from '../failures.js';
import { isBitbucketCommentId } from '../identity.js';
import {
  declineBitbucketPullRequest,
  mergeBitbucketPullRequest,
  readBitbucketCommentResolutionState,
  resolveBitbucketComment,
  unresolveBitbucketComment,
  type BitbucketWriteOutcomeV1,
} from '../mutations/pullRequestWrites.js';
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
  type BitbucketCommentResolutionResultV1,
  type BitbucketMutationResultV1,
} from './mutationContracts.js';
import { observeBitbucketEntryWithFacts } from './observeEntry.js';
import type { BitbucketTriageApiClient } from '../apiClient.js';

/**
 * The four enabled Bitbucket Cloud pull-request mutation Actions.
 *
 * Each is one exact externally visible write with its own closed input and its own confirming
 * read; there is no generic `mutate({ operation, payload })` and there will not be one
 * (`sources/SCM.md` §3.8).
 *
 * All four are declared `surfaces: ['ui', 'plugin']`, and that is the human gate. The gate is
 * **reachability, not a prompt**: omitting `agent` and `mcp` means not one of them is
 * agent-reachable at all — no prompt to approve, no tool to call, no exposure. A danger level
 * alone would only floor an agent invocation to an approval prompt, which is a weaker guarantee
 * than not being reachable. `plugin` is the same fact in the other direction: this plugin's own
 * mounted detail artifact dispatches as a plugin caller, so a write that omits it is refused
 * before it runs and nobody can reach it either.
 *
 * The shape every write here follows is the same three steps:
 *
 * 1. **fresh read** under this Action's own signal and deadline, proving the entry is still the
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
});

/**
 * This source's own bound on one mutation invocation, end to end.
 *
 * `CONTRACT.md` §5.2 leaves the deadline for an independently invoked source Action to the source:
 * Triage supplies none, and there is no public override. It covers the currentness read, the write,
 * the confirming read and the bounded merge poll together, because what it protects is one person
 * waiting on one button — not each request separately.
 */
export const BITBUCKET_MUTATION_DEADLINE_MS = 45_000;

/**
 * How long this source will wait on a merge Bitbucket queued rather than completed.
 *
 * Bitbucket's merge "may complete asynchronously, and not at our option". The poll is bounded and
 * cancellable, and when it ends without observing `MERGED` the answer is `pending` — the UI is
 * never told a queued merge merged.
 */
const MERGE_POLL_ATTEMPTS = 3;
const MERGE_POLL_INTERVAL_MS = 750;

const INVALID_INPUT = createBitbucketFailure('unsupportedContract', 'mutation-input-invalid');
const INVOCATION_CANCELLED = createBitbucketFailure('cancelled', 'invocation-cancelled');

function unavailable(failure: TriageSourceFailureV1): BitbucketMutationResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/**
 * The caller's signal, additionally bounded by this Action's own deadline.
 *
 * The deadline aborts with a `TimeoutError` so the classifier can tell it apart from a caller
 * cancellation; whichever fired first travels through every provider boundary below. The timer is
 * dropped as soon as the caller's own signal aborts and is unreferenced, so a write nobody is
 * waiting on cannot hold the daemon open.
 */
function boundMutation(callerSignal: AbortSignal | undefined): AbortSignal {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException(
      'Bitbucket did not answer this pull-request write within its deadline.',
      'TimeoutError',
    ));
  }, BITBUCKET_MUTATION_DEADLINE_MS);
  (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
  if (callerSignal === undefined) return deadline.signal;
  callerSignal.addEventListener('abort', () => { clearTimeout(timer); }, { once: true });
  return AbortSignal.any([callerSignal, deadline.signal]);
}

/** Waits between two poll attempts, and stops waiting the moment the invocation is abandoned. */
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as unknown as Readonly<{ unref?: () => void }>).unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
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
  | Readonly<{ ok: true; context: MutationContext }>
  | Readonly<{ ok: false; result: BitbucketMutationResultV1 }>
> {
  const signal = boundMutation(context.signal);
  const runtime = toBitbucketRuntime(context, signal);
  const admitted = await admitBitbucketEntryInvocation(input, runtime);
  if (!admitted.ok) return { ok: false, result: unavailable(admitted.failure) };
  return {
    ok: true,
    context: {
      client: admitted.client,
      route: admitted.route,
      localRef: input.localRef,
      signal,
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

  const write = await mergeBitbucketPullRequest({
    client: mutation.client,
    route: mutation.route,
    parameters: {
      closeSourceBranch: request.closeSourceBranch,
      mergeStrategy: request.mergeStrategy,
      ...(request.message === undefined ? {} : { message: request.message }),
    },
    signal: mutation.signal,
  });

  if (write.kind === 'rejected' || write.kind === 'failed') return shapeUnsettledWrite(write);

  if (write.kind === 'succeeded') {
    // One confirming read, never a poll: a terminal `200` is not an invitation to keep asking.
    const confirmed = await observeBitbucketEntryWithFacts(mutation);
    return confirmed.state === 'MERGED'
      ? Object.freeze({ kind: 'applied' as const, observation: confirmed.observation })
      : Object.freeze({ kind: 'pending' as const, observation: confirmed.observation });
  }

  // A queued merge. The location Bitbucket issued was already proven to be a Bitbucket API
  // location; terminality is then read from the pull request itself, because that is the resource
  // whose contract this source decodes and the fact the user actually asked about.
  let settled = await observeBitbucketEntryWithFacts(mutation);
  for (let attempt = 1; attempt < MERGE_POLL_ATTEMPTS && settled.state !== 'MERGED'; attempt += 1) {
    if (mutation.signal.aborted) break;
    await pause(MERGE_POLL_INTERVAL_MS, mutation.signal);
    settled = await observeBitbucketEntryWithFacts(mutation);
  }
  return settled.state === 'MERGED'
    ? Object.freeze({ kind: 'applied' as const, observation: settled.observation })
    : Object.freeze({ kind: 'pending' as const, observation: settled.observation });
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

  const write = await declineBitbucketPullRequest({
    client: mutation.client,
    route: mutation.route,
    signal: mutation.signal,
  });
  if (write.kind === 'rejected' || write.kind === 'failed') return shapeUnsettledWrite(write);

  const confirmed = await observeBitbucketEntryWithFacts(mutation);
  return confirmed.state === 'DECLINED'
    ? Object.freeze({ kind: 'applied' as const, observation: confirmed.observation })
    : Object.freeze({ kind: 'pending' as const, observation: confirmed.observation });
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

  const write = target === 'resolved'
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
  if (write.kind === 'failed') {
    return commentUnavailable(toTriageSourceFailure(write.failure));
  }

  const confirmed = await readBitbucketCommentResolutionState({
    client: mutation.client,
    route: mutation.route,
    commentId: request.commentId,
    signal: mutation.signal,
  });
  if (!confirmed.ok) return commentUnavailable(toTriageSourceFailure(confirmed.failure));
  return confirmed.resolution === target
    ? Object.freeze({ kind: 'applied' as const, resolution: confirmed.resolution })
    : Object.freeze({
      kind: 'rejected' as const,
      reason: 'resolution-unconfirmed' as const,
      resolution: confirmed.resolution,
    });
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
