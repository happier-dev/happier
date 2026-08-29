import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
  type TriageConfiguredSourceInstanceV1,
  type TriageSourceEntryLocalRefV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import {
  createBoundedInvocation,
  settleAtMostOnceProviderWrite,
} from '@happier-dev/triage-sources/runtime';

import { resolveAzureConfiguredOrigin } from './configuration.js';
import { createAzureSourceFailure, projectAzureSourceFailure } from './failureProjection.js';
import { isAzureDevOpsAmbiguousWriteFailure } from './failures.js';
import { foldAzureIdentityId } from './identity.js';
import { parseAzureEntryLocalRef } from './localRef.js';
import {
  abandonAzurePullRequest,
  addAzurePullRequestReviewers,
  completeAzurePullRequest,
  encodeAzureReviewerAdditions,
  reactivateAzurePullRequest,
  readAzurePullRequestThread,
  setAzurePullRequestThreadStatus,
  type AzureCompletionOptionsRequestV1,
} from './mutations/pullRequestWrites.js';
import {
  AzureAbandonInputV1Schema,
  AzureCompleteInputV1Schema,
  AzureReactivateInputV1Schema,
  AzureRequestReviewInputV1Schema,
  AzureThreadStatusInputV1Schema,
  type AzureMutationResultV1,
  type AzureThreadStatusResultV1,
} from './mutations/contracts.js';
import { toAzureTransport } from './invocation.js';
import {
  observeAzureEntry,
  openClient,
  readAzurePullRequestLocatorRoute,
  type AzureEntryObservation,
  type AzurePullRequestLocatorRoute,
} from './operations.js';
import type {
  AzureDevOpsApiClient,
  AzureDevOpsFailure,
  AzureDevOpsOrigin,
  AzurePullRequestRow,
} from './types.js';

/**
 * The five enabled Azure DevOps pull-request mutation Actions.
 *
 * Each is one exact externally visible write with its own closed input and its own confirming
 * read; there is no generic `mutate({ operation, payload })` and there will not be one
 * (`sources/SCM.md` §3.8).
 *
 * Every one is declared `surfaces: ['ui']`, and that is the human gate. The gate is
 * **reachability, not a prompt**: with no `agent` and no `mcp` surface none of them is
 * agent-reachable at all. `ui` is the write's whole product reach: the only caller is this
 * plugin's own mounted detail artifact, which reaches the daemon as present-user UI
 * authority through the authenticated mounted provenance.
 *
 * Completion carries three obligations no other forge's merge has (`sources/SCM.md` §6.7):
 *
 * 1. `completionOptions` is sent explicitly, with `transitionWorkItems` and `bypassPolicy` both an
 *    explicit `false` and `deleteSourceBranch` from the caller;
 * 2. success is **polled**, never read from the `200`, so the UI never says *merged* about a queued
 *    merge;
 * 3. the confirming read is a **field-level comparison of the values we sent**, because an unlisted
 *    property is silently ignored and a write that applied nothing while reporting success is the
 *    quietest failure in this vertical.
 */

/** The Action ids the detail surface invokes for an Azure pull-request write. */
export const AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS = Object.freeze({
  complete: 'pull-request-complete',
  abandon: 'pull-request-abandon',
  reactivate: 'pull-request-reactivate',
  requestReview: 'pull-request-request-review',
  threadStatus: 'pull-request-thread-status',
  submitReview: 'pull-request-submit-review',
  threadCommentCreate: 'pull-request-thread-comment-create',
  threadReply: 'pull-request-thread-reply',
});

/**
 * This source's own bound on one mutation invocation, end to end.
 *
 * `CONTRACT.md` §5.2 leaves the deadline for an independently invoked source Action to the source;
 * Triage supplies none and there is no public override. It covers the currentness read, the write
 * and the completion poll together, because what it protects is one person waiting on one button.
 */
export const AZURE_DEVOPS_MUTATION_DEADLINE_MS = 45_000;

/**
 * How long this source waits on a completion Azure queued rather than finished.
 *
 * `mergeStatus: 'queued'` is a documented state and completion runs as a job — `mergeId` is
 * literally *"the ID of the job used to run the pull request merge"*. The poll is bounded and
 * cancellable; when it ends without a terminal state the answer is `pending`.
 */
const COMPLETION_POLL_ATTEMPTS = 3;
const COMPLETION_POLL_INTERVAL_MS = 750;

function invalidInput(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/mutation-input-invalid',
    detail: 'This Azure DevOps mutation input is not the published V1 shape.',
  });
}

function undecodableConfiguration(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/configuration-undecodable',
    detail: 'This Azure DevOps configured-instance token was not produced by this source.',
  });
}

function entryOutsideInstance(): TriageSourceFailureV1 {
  return createAzureSourceFailure({
    class: 'unsupportedContract',
    code: 'azure-devops/entry-outside-configured-instance',
    detail: 'This entry reference was not derived from this configured Azure DevOps base.',
  });
}

function unavailable(failure: TriageSourceFailureV1): AzureMutationResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
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

export type AzureMutationContext = Readonly<{
  client: AzureDevOpsApiClient;
  viewerId: string;
  origin: AzureDevOpsOrigin;
  address: Readonly<{ project: string; repositoryId: string; pullRequestId: number }>;
  route: AzurePullRequestLocatorRoute;
  localRef: TriageSourceEntryLocalRefV1;
  signal: AbortSignal;
}>;

/**
 * Admits one mutation invocation against the exact configured base.
 *
 * The scope is rebuilt from the configured base plus the ref's own repository GUID and compared
 * byte-for-byte, so a ref minted against a different deployment cannot route through this instance.
 * Unlike a mounted detail read, a write also needs the viewer: the observation it returns carries
 * involvement facts, and *not involved* is a different statement from *unknown*.
 */
export async function admitAzureMutation(
  request: Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    localRef: TriageSourceEntryLocalRefV1;
    routingToken: string;
  }>,
  context: PluginInvocationContext,
): Promise<
  | Readonly<{ ok: true; mutation: AzureMutationContext; dispose(): void }>
  | Readonly<{ ok: false; result: AzureMutationResultV1 }>
> {
  const origin = resolveAzureConfiguredOrigin(request.instance.configuration);
  if (origin === null) return { ok: false, result: unavailable(undecodableConfiguration()) };

  const address = parseAzureEntryLocalRef(request.localRef, origin);
  if (address === null) return { ok: false, result: unavailable(entryOutsideInstance()) };
  const route = readAzurePullRequestLocatorRoute({
    origin,
    locator: { v: 1, routingToken: request.routingToken },
    pullRequestId: address.pullRequestId,
  });
  if (route === null) return { ok: false, result: unavailable(entryOutsideInstance()) };

  const bounded = createBoundedInvocation({
    callerSignal: context.signal,
    timeoutMs: AZURE_DEVOPS_MUTATION_DEADLINE_MS,
  });
  const opened = await openClient({
    services: {
      connectedAccounts: context.services.connectedAccounts,
      transport: toAzureTransport(context.services.http, bounded.signal),
      now: () => Date.now(),
    },
    instance: request.instance,
    origin,
    signal: bounded.signal,
  });
  if (!opened.ok) {
    bounded.dispose();
    return { ok: false, result: unavailable(opened.failure) };
  }

  return {
    ok: true,
    dispose: bounded.dispose,
    mutation: {
      client: opened.client,
      viewerId: opened.viewerId,
      origin,
      address: {
        project: route.project,
        repositoryId: route.repositoryId,
        pullRequestId: route.pullRequestId,
      },
      route,
      localRef: request.localRef,
      signal: bounded.signal,
    },
  };
}

export function observeAzureMutation(
  mutation: AzureMutationContext,
): Promise<AzureEntryObservation> {
  return observeAzureEntry({
    client: mutation.client,
    viewerId: mutation.viewerId,
    origin: mutation.origin,
    route: mutation.route,
    localRef: mutation.localRef,
    signal: mutation.signal,
  });
}

async function settleAzureEntryWrite(input: Readonly<{
  mutation: AzureMutationContext;
  dispatch: () => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; failure: AzureDevOpsFailure }>>;
  applied: (row: AzurePullRequestRow) => boolean;
}>): Promise<
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'result'; result: AzureMutationResultV1 }>
> {
  let ambiguousDispatchFailure: AzureDevOpsFailure | undefined;
  const settled = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      const result = await input.dispatch();
      if (!result.ok && isAzureDevOpsAmbiguousWriteFailure(result.failure)) {
        ambiguousDispatchFailure = result.failure;
      }
      return result;
    },
    mayHaveChanged: (write) => !write.ok && isAzureDevOpsAmbiguousWriteFailure(write.failure),
    confirm: async () => {
      const confirmed = await observeAzureMutation(input.mutation);
      if (confirmed.row === null) {
        return confirmed.observation.kind === 'unresolved'
          ? { kind: 'uncertain' as const, failure: confirmed.observation.failure }
          : { kind: 'uncertain' as const };
      }
      return input.applied(confirmed.row)
        ? { kind: 'applied' as const, observation: confirmed.observation }
        : { kind: 'unchanged' as const, observation: confirmed.observation };
    },
  });
  if (settled.kind === 'settled') {
    return settled.result.ok
      ? { kind: 'accepted' }
      : { kind: 'result', result: unavailable(projectAzureSourceFailure(settled.result.failure)) };
  }
  if (settled.kind === 'applied' && settled.observation !== undefined) {
    return { kind: 'result', result: Object.freeze({ kind: 'applied', observation: settled.observation }) };
  }
  if (settled.kind === 'unchanged') {
    return {
      kind: 'result',
      result: Object.freeze({
        kind: 'uncertain' as const,
        ...(settled.observation === undefined ? {} : { observation: settled.observation }),
        ...(ambiguousDispatchFailure === undefined
          ? {}
          : { failure: projectAzureSourceFailure(ambiguousDispatchFailure) }),
      }),
    };
  }
  if (settled.kind === 'applied') {
    return { kind: 'result', result: Object.freeze({ kind: 'uncertain' as const }) };
  }
  return {
    kind: 'result',
    result: Object.freeze({
      kind: 'uncertain' as const,
      ...(settled.observation === undefined ? {} : { observation: settled.observation }),
      ...(settled.failure === undefined
        ? {}
        : { failure: settled.failure }),
    }),
  };
}

function boundedDetail(value: string | null): string | undefined {
  if (value === null) return undefined;
  const projected = projectTriageDisplayTextV1(
    value,
    MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  ).value;
  return projected.length === 0 ? undefined : projected;
}

/* ------------------------------------------------------------------ complete */

/**
 * `azure-devops/pull-request/complete` — Azure's merge, and irreversible on the forge.
 *
 * The pinned source commit is the one the user's read observed; it is compared against a fresh read
 * and the completion is refused before any write when it has moved. Filling the pin from that fresh
 * read would reintroduce the exact race, and retrying after the head moved would re-decide on the
 * user's behalf about commits they never saw.
 */
export async function completeAzureDevOpsPullRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureMutationResultV1> {
  const parsed = AzureCompleteInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());
  const request = parsed.data;

  const admitted = await admitAzureMutation(
    { instance: request.instance, localRef: request.localRef, routingToken: request.routingToken },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.mutation;
  try {

  const current = await observeAzureMutation(mutation);
  if (current.row === null) {
    return unavailable(
      current.observation.kind === 'unresolved' ? current.observation.failure : invalidInput(),
    );
  }
  if (current.row.status !== 'active') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-active' as const,
      observation: current.observation,
    });
  }
  if (
    current.row.lastMergeSourceCommitId === null
    || current.row.lastMergeSourceCommitId !== request.observedSourceCommitId
  ) {
    // Zero writes. The host re-renders against the source commit this read observed and the user
    // decides again about the commits that are actually there.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'head-advanced' as const,
      observation: current.observation,
    });
  }

  const sent = {
    deleteSourceBranch: request.deleteSourceBranch,
    transitionWorkItems: false as const,
    bypassPolicy: false as const,
    bypassReason: '' as const,
  };
  const write = await settleAzureEntryWrite({
    mutation,
    dispatch: async () => await completeAzurePullRequest({
      client: mutation.client,
      address: mutation.address,
      completionOptions: sent,
      signal: mutation.signal,
    }),
    applied: (row) => isCompletionTerminal(row) && completionOptionsHeld(row, sent),
  });
  if (write.kind === 'result') return write.result;

  // The `200` acknowledged the status update. Everything below reads the pull request itself.
  let settled = await observeAzureMutation(mutation);
  for (
    let attempt = 1;
    attempt < COMPLETION_POLL_ATTEMPTS && !isCompletionTerminal(settled.row);
    attempt += 1
  ) {
    if (mutation.signal.aborted) break;
    await pause(COMPLETION_POLL_INTERVAL_MS, mutation.signal);
    settled = await observeAzureMutation(mutation);
  }

  const row = settled.row;
  if (row === null) {
    // The write was accepted and the confirming read could not be made. Reporting the read's
    // failure as the completion's failure would tell the user their merge did not happen.
    return Object.freeze({ kind: 'pending' as const, observation: settled.observation });
  }

  if (row.mergeStatus === 'conflicts' || row.mergeStatus === 'rejectedByPolicy' || row.mergeStatus === 'failure') {
    const detail = boundedDetail(row.mergeFailureMessage ?? row.mergeFailureType);
    return Object.freeze({
      kind: 'rejected' as const,
      reason: row.mergeStatus,
      ...(detail === undefined ? {} : { detail }),
      observation: settled.observation,
    });
  }

  // The field-level comparison. Azure may answer `200` and silently ignore a property, and a
  // completion whose options were dropped would delete a branch the user asked to keep — or keep
  // one they asked to delete — while the status alone still read `completed`.
  const optionsHeld = completionOptionsHeld(row, sent);

  if (isCompletionTerminal(row)) {
    return optionsHeld
      ? Object.freeze({ kind: 'applied' as const, observation: settled.observation })
      : Object.freeze({
        kind: 'rejected' as const,
        reason: 'fields-ignored' as const,
        observation: settled.observation,
      });
  }

  return Object.freeze({
    kind: 'pending' as const,
    observation: settled.observation,
    ...(row.autoCompleteSetBy === null ? {} : { autoCompleteEnabled: true as const }),
  });
  } finally { admitted.dispose(); }
}

/**
 * Terminal completion success, exactly as Azure defines it.
 *
 * All three facts are required together. `status === 'completed'` alone is the acknowledgement of
 * the update, and `lastMergeCommit` is documented as empty while *"the most recent merge is in
 * progress or was unsuccessful"* — so a populated one is what separates a finished merge from a
 * queued one.
 */
function isCompletionTerminal(row: AzurePullRequestRow | null): boolean {
  return row !== null
    && row.status === 'completed'
    && row.mergeStatus === 'succeeded'
    && row.lastMergeCommitId !== null;
}

/** Field-level proof that Azure retained every completion option this Action sent. */
function completionOptionsHeld(
  row: AzurePullRequestRow,
  sent: AzureCompletionOptionsRequestV1,
): boolean {
  const applied = row.completionOptions;
  return applied !== null
    && applied.deleteSourceBranch === sent.deleteSourceBranch
    && applied.transitionWorkItems === sent.transitionWorkItems
    && applied.bypassPolicy === sent.bypassPolicy
    // Azure omits a completion option it holds no value for, so an accepted empty
    // `bypassReason` comes back either as `''` or not at all. Both prove the stored
    // justification is gone; only a surviving non-empty one proves the write was ignored.
    && (applied.bypassReason === null || applied.bypassReason === sent.bypassReason);
}

/* ------------------------------------------------------------------- abandon */

/**
 * `azure-devops/pull-request/abandon` — Azure's close.
 *
 * It carries no head pin: abandoning is head-independent. Unlike Bitbucket's decline it IS
 * reversible — Azure reactivates an abandoned pull request by setting `status` back to `active` —
 * so the confirmation says so rather than implying a permanence this forge does not have.
 */
export async function abandonAzureDevOpsPullRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureMutationResultV1> {
  const parsed = AzureAbandonInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());
  const request = parsed.data;

  const admitted = await admitAzureMutation(
    { instance: request.instance, localRef: request.localRef, routingToken: request.routingToken },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.mutation;
  try {

  const current = await observeAzureMutation(mutation);
  if (current.row === null) {
    return unavailable(
      current.observation.kind === 'unresolved' ? current.observation.failure : invalidInput(),
    );
  }
  if (current.row.status !== 'active') {
    // Already abandoned, or already completed. Abandoning a completed pull request is not a
    // converging no-op — it would report a merged pull request as abandoned — so it is refused
    // with the state that made it inapplicable.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-active' as const,
      observation: current.observation,
    });
  }

  const write = await settleAzureEntryWrite({
    mutation,
    dispatch: async () => await abandonAzurePullRequest({
      client: mutation.client,
      address: mutation.address,
      signal: mutation.signal,
    }),
    applied: (row) => row.status === 'abandoned',
  });
  if (write.kind === 'result') return write.result;

  // One confirming read, and it compares the field we sent rather than the status code: a `PATCH`
  // Azure silently ignored answers `200` and changes nothing.
  const settled = await observeAzureMutation(mutation);
  if (settled.row === null) {
    return Object.freeze({
      kind: 'uncertain' as const,
      observation: settled.observation,
      ...(settled.observation.kind === 'unresolved'
        ? { failure: settled.observation.failure }
        : {}),
    });
  }
  return settled.row?.status === 'abandoned'
    ? Object.freeze({ kind: 'applied' as const, observation: settled.observation })
    : Object.freeze({
      kind: 'rejected' as const,
      reason: 'fields-ignored' as const,
      observation: settled.observation,
    });
  } finally { admitted.dispose(); }
}

/* ---------------------------------------------------------------- reactivate */

/**
 * `azure-devops/pull-request/reactivate` — Azure's reopen, and the exact inverse of abandon.
 *
 * It is gated on the pull request being **abandoned**, not merely inactive. A completed pull
 * request is also not active, and setting a completed one back to `active` is not a reopen: it
 * would try to undo a merge that already landed. Refusing with the state that made it inapplicable
 * is the same rule abandon follows, pointed the other way.
 */
export async function reactivateAzureDevOpsPullRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureMutationResultV1> {
  const parsed = AzureReactivateInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());
  const request = parsed.data;

  const admitted = await admitAzureMutation(
    { instance: request.instance, localRef: request.localRef, routingToken: request.routingToken },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.mutation;
  try {

  const current = await observeAzureMutation(mutation);
  if (current.row === null) {
    return unavailable(
      current.observation.kind === 'unresolved' ? current.observation.failure : invalidInput(),
    );
  }
  if (current.row.status !== 'abandoned') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-abandoned' as const,
      observation: current.observation,
    });
  }

  const write = await settleAzureEntryWrite({
    mutation,
    dispatch: async () => await reactivateAzurePullRequest({
      client: mutation.client,
      address: mutation.address,
      signal: mutation.signal,
    }),
    applied: (row) => row.status === 'active',
  });
  if (write.kind === 'result') return write.result;

  // The same confirming comparison abandon makes, against the field this write sent: a `PATCH`
  // Azure silently ignored answers `200` and changes nothing.
  const settled = await observeAzureMutation(mutation);
  if (settled.row === null) {
    return Object.freeze({
      kind: 'uncertain' as const,
      observation: settled.observation,
      ...(settled.observation.kind === 'unresolved'
        ? { failure: settled.observation.failure }
        : {}),
    });
  }
  return settled.row?.status === 'active'
    ? Object.freeze({ kind: 'applied' as const, observation: settled.observation })
    : Object.freeze({
      kind: 'rejected' as const,
      reason: 'fields-ignored' as const,
      observation: settled.observation,
    });
  } finally { admitted.dispose(); }
}

/* ------------------------------------------------------------ request review */

/**
 * `azure-devops/pull-request/request-review` — additive, and never a reviewer set.
 *
 * One documented bulk `POST` whose body is an array of strict identity-only objects, followed by
 * an authoritative re-read that confirms the selected ids arrived while every existing reviewer
 * and vote stays exactly as the provider owns it. It never uses the per-reviewer
 * `PUT …/reviewers/{reviewerId}` create-or-vote route, never sends a replacement set, and never
 * removes anybody.
 *
 * An identity that already reviews this pull request is refused before the write rather than
 * re-sent: Azure's additive route carries a vote for a reviewer it already knows, so re-adding one
 * is how somebody's approval gets reset by a button that said *request review*.
 */
export async function requestAzureDevOpsPullRequestReview(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureMutationResultV1> {
  const parsed = AzureRequestReviewInputV1Schema.safeParse(input);
  if (!parsed.success) return unavailable(invalidInput());
  const request = parsed.data;

  const reviewers = encodeAzureReviewerAdditions(request.reviewerIds);
  if (reviewers === null) return unavailable(invalidInput());

  const admitted = await admitAzureMutation(
    { instance: request.instance, localRef: request.localRef, routingToken: request.routingToken },
    context,
  );
  if (!admitted.ok) return admitted.result;
  const mutation = admitted.mutation;
  try {

  const current = await observeAzureMutation(mutation);
  if (current.row === null) {
    return unavailable(
      current.observation.kind === 'unresolved' ? current.observation.failure : invalidInput(),
    );
  }
  if (current.row.status !== 'active') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'entry-not-active' as const,
      observation: current.observation,
    });
  }
  if (
    current.row.lastMergeSourceCommitId === null
    || current.row.lastMergeSourceCommitId !== request.observedSourceCommitId
  ) {
    // Zero writes. Asking somebody to review commits the requester never saw is a different
    // request from the one they made.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'head-advanced' as const,
      observation: current.observation,
    });
  }
  // Folded, because Azure hands the same identity GUID back in whatever case the producing
  // service wrote it. A case-sensitive membership test answers *not a reviewer* about somebody
  // who is one, and the additive route then carries a vote for a reviewer Azure already knows —
  // which is how a button labelled *request review* resets an approval.
  const existingVotes = new Map(
    current.row.reviewers.map((reviewer) => [foldAzureIdentityId(reviewer.id), reviewer.vote] as const),
  );
  const existing = new Set(existingVotes.keys());
  if (reviewers.some((reviewer) => existing.has(foldAzureIdentityId(reviewer.id)))) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'reviewer-already-present' as const,
      observation: current.observation,
    });
  }

  const write = await addAzurePullRequestReviewers({
    client: mutation.client,
    address: mutation.address,
    reviewers,
    signal: mutation.signal,
  });
  // A write whose outcome is UNKNOWN is not a write that failed. A timed-out or aborted `POST`
  // may already have added every reviewer, so answering `unavailable` here tells the user nothing
  // happened about an effect nobody observed — and the natural response to that is to press the
  // button again, which is exactly the blind repeat `sources/SCM.md` §6.7 forbids. Only outcomes
  // the provider itself decided (`4xx`, a refused contract, a rate limit) end the Action here;
  // everything ambiguous falls through to the one authoritative list read below, which is the
  // only thing that can say what actually landed.
  if (!write.ok && !isAzureDevOpsAmbiguousWriteFailure(write.failure)) {
    return unavailable(projectAzureSourceFailure(write.failure));
  }

  // The authoritative reviewer list, read back from the pull request itself rather than trusted
  // from the write's own response body. Confirmation is all this Action ever does after a write,
  // and it never repeats an effect whose outcome is unknown.
  const settled = await observeAzureMutation(mutation);
  const settledReviewers = settled.row === null
    ? null
    : new Map(
      settled.row.reviewers.map((reviewer) => [foldAzureIdentityId(reviewer.id), reviewer.vote] as const),
    );
  const confirmed = settledReviewers !== null
    && reviewers.every((reviewer) => settledReviewers.has(foldAzureIdentityId(reviewer.id)))
    && [...existingVotes].every(
      ([id, vote]) => settledReviewers.get(id) === vote,
    );
  if (confirmed) {
    return Object.freeze({ kind: 'applied' as const, observation: settled.observation });
  }
  if (!write.ok) {
    // The response was lost and the authoritative list still cannot decide whether the addition
    // landed. Preserve both facts as `uncertain`: `pending` is reserved for a provider-accepted
    // effect whose asynchronous completion we are waiting to observe, while this POST supplied no
    // acceptance evidence at all. The UI can now tell the user to reload before deciding whether
    // to retry, without pretending the transport failure proved a negative.
    return Object.freeze({
      kind: 'uncertain' as const,
      observation: settled.observation,
      failure: projectAzureSourceFailure(write.failure),
    });
  }
  // Azure accepted the request, but its authoritative list has not reflected the addition yet.
  // That is ordinary provider lag, distinct from an answer-lost write.
  return Object.freeze({ kind: 'pending' as const, observation: settled.observation });
  } finally { admitted.dispose(); }
}

/* ------------------------------------------------------------- thread status */

/** Azure thread ids are positive integers; the Threads projection publishes them as text. */
const THREAD_ID_PATTERN = /^[1-9][0-9]*$/u;

function threadUnavailable(failure: TriageSourceFailureV1): AzureThreadStatusResultV1 {
  return Object.freeze({ kind: 'unavailable' as const, failure });
}

/**
 * `azure-devops/pull-request/thread-status` — one review thread's status, and nothing else.
 *
 * The body carries `status` alone. Azure's thread update accepts a comment array and a thread
 * context too, and sending either would let a status change quietly rewrite the conversation it
 * was about.
 *
 * The result is the thread's own re-read status rather than a pull-request observation: what the
 * caller changed is the thread, and handing back the entry would answer a question nobody asked.
 */
export async function setAzureDevOpsPullRequestThreadStatus(
  input: unknown,
  context: PluginInvocationContext,
): Promise<AzureThreadStatusResultV1> {
  const parsed = AzureThreadStatusInputV1Schema.safeParse(input);
  if (!parsed.success) return threadUnavailable(invalidInput());
  const request = parsed.data;
  if (!THREAD_ID_PATTERN.test(request.threadId)) return threadUnavailable(invalidInput());
  const threadId = Number(request.threadId);

  const admitted = await admitAzureMutation(
    { instance: request.instance, localRef: request.localRef, routingToken: request.routingToken },
    context,
  );
  if (!admitted.ok) {
    const result = admitted.result;
    return threadUnavailable(
      result.kind === 'unavailable' ? result.failure : invalidInput(),
    );
  }
  const mutation = admitted.mutation;
  try {

  // The thread id is not route authority. Prove the locator against the exact pull request before
  // addressing its thread subresource, just as every entry mutation does with its current read.
  const entry = await observeAzureMutation(mutation);
  if (entry.row === null) {
    return threadUnavailable(
      entry.observation.kind === 'unresolved' ? entry.observation.failure : invalidInput(),
    );
  }

  const current = await readAzurePullRequestThread({
    client: mutation.client,
    address: mutation.address,
    threadId,
    signal: mutation.signal,
  });
  if (!current.ok) return threadUnavailable(projectAzureSourceFailure(current.failure));
  if (current.status === request.status) {
    // Nothing to write. A `PATCH` that sets a status to the one it already has is a request whose
    // only possible effect is a race with somebody else's change.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'already-in-status' as const,
      status: current.status,
    });
  }

  let ambiguousThreadWriteFailure: AzureDevOpsFailure | undefined;
  const write = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      const result = await setAzurePullRequestThreadStatus({
        client: mutation.client,
        address: mutation.address,
        threadId,
        status: request.status,
        signal: mutation.signal,
      });
      if (!result.ok && isAzureDevOpsAmbiguousWriteFailure(result.failure)) {
        ambiguousThreadWriteFailure = result.failure;
      }
      return result;
    },
    mayHaveChanged: (result) => !result.ok && isAzureDevOpsAmbiguousWriteFailure(result.failure),
    confirm: async () => {
      const confirmed = await readAzurePullRequestThread({
        client: mutation.client,
        address: mutation.address,
        threadId,
        signal: mutation.signal,
      });
      if (!confirmed.ok) return { kind: 'uncertain' as const, failure: confirmed.failure };
      return confirmed.status === request.status
        ? { kind: 'applied' as const, observation: confirmed.status }
        : { kind: 'unchanged' as const, observation: confirmed.status };
    },
  });
  if (write.kind !== 'settled') {
    if (write.kind === 'applied') {
      return Object.freeze({ kind: 'applied' as const, status: write.observation });
    }
    if (write.kind === 'unchanged') {
      return Object.freeze({
        kind: 'uncertain' as const,
        status: write.observation,
        ...(ambiguousThreadWriteFailure === undefined
          ? {}
          : { failure: projectAzureSourceFailure(ambiguousThreadWriteFailure) }),
      });
    }
    return Object.freeze({
      kind: 'uncertain' as const,
      ...(write.observation === undefined ? {} : { status: write.observation }),
      ...(write.failure === undefined
        ? {}
        : { failure: projectAzureSourceFailure(write.failure) }),
    });
  }
  if (!write.result.ok) {
    return threadUnavailable(projectAzureSourceFailure(write.result.failure));
  }

  const settled = await readAzurePullRequestThread({
    client: mutation.client,
    address: mutation.address,
    threadId,
    signal: mutation.signal,
  });
  if (!settled.ok) {
    return Object.freeze({
      kind: 'uncertain' as const,
      failure: projectAzureSourceFailure(settled.failure),
    });
  }
  return settled.status === request.status
    ? Object.freeze({ kind: 'applied' as const, status: settled.status })
    : Object.freeze({
      kind: 'rejected' as const,
      reason: 'fields-ignored' as const,
      status: settled.status,
    });
  } finally { admitted.dispose(); }
}
