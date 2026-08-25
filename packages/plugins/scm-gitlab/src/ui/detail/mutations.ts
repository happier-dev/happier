/**
 * What the GitLab detail surface may write, what each write needs, and what its
 * answer means.
 *
 * The three merge-request writes are declared Actions with their own strict
 * inputs and their own strict result unions (`triage/mutations/contracts.ts`).
 * This module owns only the three decisions the SURFACE has to make around them,
 * and it owns them as plain functions so they can be checked without mounting a
 * device:
 *
 *  1. which writes the applied observation actually offers;
 *  2. how an offered write's input is built from that same observation — and when
 *     it cannot be built at all;
 *  3. what one settled dispatch MEANS, which is not the same question as whether
 *     the dispatch succeeded.
 *
 * (3) is the one worth stating twice. `useExecutePluginAction` settles the
 * TRANSPORT: `success` means the Action ran and returned, not that GitLab
 * changed. The Action's own result union carries the outcome, and GitLab's is
 * unusually rich because GitLab's own answers are: a merge that MERGED and a
 * merge that was SCHEDULED are different facts to a person waiting on a release;
 * a refusal that never left this process is different from one GitLab made; and
 * a write whose confirming read could not settle may already have landed in
 * production. Flattening any of those into "it worked" or "it failed" is how a
 * duplicate merge ships, so this projection keeps all of them apart.
 *
 * Nothing here reads a provider, holds a credential, or re-decides policy. Every
 * input is parsed by the write contract's own schema before it is offered to the
 * host, so this module cannot invent a shape the Action would then have to
 * reject — and an input the schema refuses becomes "not offered" rather than a
 * button whose every press fails.
 */

import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GitlabMergeRequestCloseInputV1Schema,
  GitlabMergeRequestCloseResultV1Schema,
  GitlabMergeRequestMarkReadyInputV1Schema,
  GitlabMergeRequestMarkReadyResultV1Schema,
  GitlabMergeRequestMergeInputV1Schema,
  GitlabMergeRequestMergeResultV1Schema,
  GitlabMergeRequestReopenInputV1Schema,
  GitlabMergeRequestReopenResultV1Schema,
  GitlabMergeRequestReviewerChangeInputV1Schema,
  GitlabMergeRequestReviewerChangeResultV1Schema,
  GitlabMergeRequestDiscussionResolutionInputV1Schema,
  GitlabMergeRequestDiscussionResolutionResultV1Schema,
  GitlabIssueCloseInputV1Schema,
  GitlabIssueCloseResultV1Schema,
  GitlabIssueReopenInputV1Schema,
  GitlabIssueReopenResultV1Schema,
  GitlabIssueAssignInputV1Schema,
  GitlabIssueAssignResultV1Schema,
  GitlabIssueLabelInputV1Schema,
  GitlabIssueLabelResultV1Schema,
  type GitlabMergeRequestCloseInputV1,
  type GitlabMergeRequestMarkReadyInputV1,
  type GitlabMergeRequestMergeInputV1,
  type GitlabMergeRequestStateRowV1,
  type GitlabIssueStateRowV1,
} from '../../triage/mutations/contracts.js';

/** The three declared writes, named by the effect a person asked for. */
export type GitlabWriteIdV1 =
  | 'merge' | 'markReady' | 'close' | 'mergeRequestReopen'
  | 'reviewerChange' | 'discussionResolution'
  | 'issueClose' | 'issueReopen' | 'issueAssign' | 'issueLabel';
export type GitlabMergeRequestWriteIdV1 =
  | 'merge' | 'markReady' | 'close' | 'mergeRequestReopen'
  | 'reviewerChange' | 'discussionResolution';

type ObservedState = TriageDetailSurfaceInputV1['observation']['snapshot']['state'];

const ACTIVE_WRITES: readonly GitlabMergeRequestWriteIdV1[] =
  Object.freeze(['merge', 'markReady', 'close', 'reviewerChange']);
const NO_WRITES: readonly GitlabMergeRequestWriteIdV1[] = Object.freeze([]);

/**
 * The writes this entry offers, from the applied observation alone.
 *
 * All three Actions are merge-request writes and all three transition an OPEN
 * merge request, so an issue offers none of them and neither does a merge
 * request that is already closed or merged. A control whose every press the
 * provider refuses is worse than no control.
 *
 * The branch is on the projected `presentation` state and never on
 * `nativeLabel`. The native label is GitLab's own word kept for display, and
 * deciding what a user may write from display text would make one relabelled
 * string — or one self-managed deployment's translation — change behaviour.
 *
 * `markReady` is offered for every active merge request rather than only for a
 * draft. The observation carries no draft flag, and rather than infer one from
 * display text this defers to the Action, which reads GitLab's own `draft`
 * boolean in its preflight and converges: an already-ready merge request answers
 * `ready` having written nothing and notified nobody.
 */
export function gitlabOfferedMergeRequestWritesV1(params: Readonly<{
  kindId: string;
  state: ObservedState;
}>): readonly GitlabMergeRequestWriteIdV1[] {
  if (params.kindId !== 'merge-request') return NO_WRITES;
  // `resolved`, `closed`, `unknown` and anything a later contract adds state
  // nothing this build can turn into a transition, so they offer nothing rather
  // than guessing. GitLab declares no reopen Action, so a closed merge request
  // is correctly offered no control at all.
  if (params.state.presentation === 'active') return ACTIVE_WRITES;
  return params.state.presentation === 'closed'
    ? Object.freeze(['mergeRequestReopen'])
    : NO_WRITES;
}

export function gitlabOfferedIssueWritesV1(params: Readonly<{
  kindId: string;
  state: ObservedState;
}>): readonly GitlabWriteIdV1[] {
  if (params.kindId !== 'issue') return NO_WRITES;
  return params.state.presentation === 'active'
    ? Object.freeze(['issueClose', 'issueAssign', 'issueLabel'])
    : params.state.presentation === 'closed'
      ? Object.freeze(['issueReopen', 'issueAssign', 'issueLabel'])
      : NO_WRITES;
}

function localRefOf(input: TriageDetailSurfaceInputV1) {
  const { entryRef } = input.observation;
  return {
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  };
}

/**
 * The close input: the configured instance whose account is rematerialized for
 * the invocation, and the canonical entry ref. Nothing else.
 *
 * It carries no pin, because `sources/SCM.md` §2.6 puts close in the
 * head-independent row — a pin here would refuse a close that a collaborator's
 * unrelated push had not invalidated. It carries no source-branch-removal
 * decision either: that authority was never granted to this control, and a value
 * the user never saw must not travel with their write.
 *
 * It therefore builds for every merge request, including one whose head GitLab
 * has not reported yet. Withholding close there would remove a capability that
 * works.
 */
export function buildGitlabMergeRequestCloseInputV1(
  input: TriageDetailSurfaceInputV1,
): GitlabMergeRequestCloseInputV1 | null {
  const parsed = GitlabMergeRequestCloseInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
  });
  return parsed.success ? parsed.data : null;
}

function buildWithSchema<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function buildGitlabMergeRequestReopenInputV1(input: TriageDetailSurfaceInputV1) {
  return buildWithSchema(GitlabMergeRequestReopenInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
  });
}

export function buildGitlabIssueCloseInputV1(input: TriageDetailSurfaceInputV1) {
  return buildWithSchema(GitlabIssueCloseInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedRevision: input.observation.nativeRevision,
  });
}

export function buildGitlabIssueReopenInputV1(input: TriageDetailSurfaceInputV1) {
  return buildWithSchema(GitlabIssueReopenInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedRevision: input.observation.nativeRevision,
  });
}

export function buildGitlabReviewerChangeInputV1(
  input: TriageDetailSurfaceInputV1,
  operation: 'add' | 'remove',
  reviewerUsernames: readonly string[],
) {
  return buildWithSchema(GitlabMergeRequestReviewerChangeInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedHeadSha: input.observation.nativeRevision,
    operation,
    reviewerUsernames,
  });
}

export function buildGitlabDiscussionResolutionInputV1(
  input: TriageDetailSurfaceInputV1,
  discussionId: string,
  resolved: boolean,
) {
  return buildWithSchema(GitlabMergeRequestDiscussionResolutionInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedHeadSha: input.observation.nativeRevision,
    discussionId,
    resolved,
  });
}

export function buildGitlabIssueAssignInputV1(
  input: TriageDetailSurfaceInputV1,
  operation: 'add' | 'remove',
  assigneeUsernames: readonly string[],
) {
  return buildWithSchema(GitlabIssueAssignInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedRevision: input.observation.nativeRevision,
    operation,
    assigneeUsernames,
  });
}

export function buildGitlabIssueLabelInputV1(
  input: TriageDetailSurfaceInputV1,
  operation: 'add' | 'remove',
  labelNames: readonly string[],
) {
  return buildWithSchema(GitlabIssueLabelInputV1Schema, {
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedRevision: input.observation.nativeRevision,
    operation,
    labelNames,
  });
}

/**
 * The merge input, carrying the head the USER is looking at.
 *
 * The pin is the applied observation's `nativeRevision`, which for a GitLab merge
 * request is GitLab's own `sha` — the head commit that read observed. It comes
 * from there and from nowhere else: its whole value as a precondition is that it
 * is the commit the decision was made against, so a fresh read at press time
 * would defeat the guarantee it exists to provide. That is the race, not the fix.
 * It is never filled from a pipeline's or a per-file diff's sha, neither of which
 * is the source-branch head.
 *
 * GitLab consumes it as its own `sha` precondition, so an observation carrying no
 * head — or one whose revision is not a commit object, as an issue's `updated_at`
 * is — builds NOTHING. A merge dispatched without the pin is unconditional, and
 * an unconditional merge of whatever the head has since become is exactly what
 * §2.6 exists to prevent; the control is withheld with a stated reason instead.
 */
export function buildGitlabMergeRequestMergeInputV1(
  input: TriageDetailSurfaceInputV1,
): GitlabMergeRequestMergeInputV1 | null {
  const parsed = GitlabMergeRequestMergeInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedHeadSha: input.observation.nativeRevision,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The mark-ready input. It carries the same head pin as the merge, because the
 * draft→ready transition fans a notification out to every named reviewer and
 * that fan-out IS the write: against a stale head, humans are summoned to review
 * commits the acting user never saw.
 */
export function buildGitlabMergeRequestMarkReadyInputV1(
  input: TriageDetailSurfaceInputV1,
): GitlabMergeRequestMarkReadyInputV1 | null {
  const parsed = GitlabMergeRequestMarkReadyInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    observedHeadSha: input.observation.nativeRevision,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The host code that proves the user was asked and said no.
 *
 * It settles before the Action handler is entered, so it is the one rejection
 * this surface may describe as having written nothing. Every other error code is
 * reported as an incomplete write, because the generic transport cannot tell a
 * refused dispatch from a handler that ran.
 */
export const GITLAB_CURRENT_INTENT_REJECTED_CODE = 'plugin_action_current_intent_rejected';

/**
 * The effect a write actually achieved. These are kept apart rather than
 * collapsed into "done" because GitLab distinguishes them and a person acts on
 * the difference: a `scheduled` merge has not merged, and telling someone
 * waiting on a release that it did would be false.
 */
export type GitlabWriteEffectV1 =
  | 'merged' | 'scheduled' | 'ready' | 'closed' | 'reopened'
  | 'reviewersChanged' | 'discussionStateChanged' | 'assigneesChanged' | 'labelsChanged';
type GitlabMutationStateRowV1 = GitlabMergeRequestStateRowV1 | GitlabIssueStateRowV1;

export type GitlabWriteOutcomeV1 =
  /** GitLab proved the requested state, by a confirming read. */
  | Readonly<{ kind: 'applied'; effect: GitlabWriteEffectV1; item: GitlabMutationStateRowV1 }>
  /** The item moved under the user and NOTHING was written. */
  | Readonly<{ kind: 'reconfirmationRequired'; observed: GitlabMutationStateRowV1 }>
  /** GitLab, or this client's preflight, performed no transition. */
  | Readonly<{
    kind: 'refused';
    reason: string;
    dispatched: boolean;
    observed?: GitlabMutationStateRowV1;
    messages?: readonly string[];
  }>
  /** The write was dispatched and its outcome is NOT proven. Never a blind retry. */
  | Readonly<{
    kind: 'unconfirmed';
    observed?: GitlabMutationStateRowV1;
    failure?: TriageSourceFailureV1;
  }>
  /** Nothing was attempted: admission, authorization or the currentness read failed. */
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>
  /** The user was asked to confirm and declined. Nothing left this process. */
  | Readonly<{ kind: 'declined' }>
  /** The host refused or failed the dispatch itself. */
  | Readonly<{ kind: 'rejected'; code: string; message: string }>
  /** The transport could not settle. It may already have run. */
  | Readonly<{ kind: 'uncertain' }>
  /** The Action returned and this build cannot say what it returned as. */
  | Readonly<{ kind: 'unreadable' }>;

const RESULT_SCHEMA_BY_WRITE = Object.freeze({
  merge: GitlabMergeRequestMergeResultV1Schema,
  markReady: GitlabMergeRequestMarkReadyResultV1Schema,
  close: GitlabMergeRequestCloseResultV1Schema,
  mergeRequestReopen: GitlabMergeRequestReopenResultV1Schema,
  reviewerChange: GitlabMergeRequestReviewerChangeResultV1Schema,
  discussionResolution: GitlabMergeRequestDiscussionResolutionResultV1Schema,
  issueClose: GitlabIssueCloseResultV1Schema,
  issueReopen: GitlabIssueReopenResultV1Schema,
  issueAssign: GitlabIssueAssignResultV1Schema,
  issueLabel: GitlabIssueLabelResultV1Schema,
});

/**
 * The success arm each write's own result union spells differently. The shared
 * arms are shared; only the achievement is per-write, which is exactly how the
 * contract is built.
 */
const APPLIED_EFFECT_BY_KIND: Readonly<Record<string, GitlabWriteEffectV1 | undefined>> =
  Object.freeze({
    merged: 'merged',
    scheduled: 'scheduled',
    ready: 'ready',
    closed: 'closed',
    reopened: 'reopened',
    reviewersChanged: 'reviewersChanged',
    discussionStateChanged: 'discussionStateChanged',
    assigneesChanged: 'assigneesChanged',
    labelsChanged: 'labelsChanged',
  });

/**
 * Projects one dispatch into the outcome a panel renders.
 *
 * The result is parsed through the invoked write's OWN schema rather than a
 * shared one, so a `ready` answer can never be read off a merge dispatch. A
 * `success` dispatch whose result does not parse is NOT an applied write: the
 * Action returned, and this build cannot say what it returned as. Saying
 * "merged" there would be an invention.
 *
 * Returns `null` while the control is at rest or in flight, because those are
 * states the control itself already shows and not settled facts to report.
 */
export function projectGitlabWriteOutcomeV1(
  write: GitlabWriteIdV1,
  execution: PluginActionExecution<unknown>,
): GitlabWriteOutcomeV1 | null {
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') return Object.freeze({ kind: 'uncertain' as const });
  if (execution.status === 'error') {
    // Only the confirmation-declined code proves nothing was written. Every other
    // host error — a refused surface, a transport fault, a handler that threw
    // after dispatching — is reported as an INCOMPLETE write, because the generic
    // transport cannot tell a refused dispatch from a handler that ran.
    return execution.code === GITLAB_CURRENT_INTENT_REJECTED_CODE
      ? Object.freeze({ kind: 'declined' as const })
      : Object.freeze({
        kind: 'rejected' as const,
        code: execution.code,
        message: execution.message,
      });
  }

  const parsed = RESULT_SCHEMA_BY_WRITE[write].safeParse(execution.result);
  if (!parsed.success) return Object.freeze({ kind: 'unreadable' as const });
  const result = parsed.data;

  switch (result.kind) {
    case 'reconfirmationRequired':
      return Object.freeze({ kind: 'reconfirmationRequired' as const, observed: result.observed });
    case 'refused':
      return Object.freeze({
        kind: 'refused' as const,
        reason: result.reason,
        dispatched: result.dispatched,
        ...(result.observed === undefined ? {} : { observed: result.observed }),
        ...(result.messages === undefined ? {} : { messages: result.messages }),
      });
    case 'unconfirmed':
      return Object.freeze({
        kind: 'unconfirmed' as const,
        ...(result.observed === undefined ? {} : { observed: result.observed }),
        ...(result.failure === undefined ? {} : { failure: result.failure }),
      });
    case 'unavailable':
      return Object.freeze({ kind: 'unavailable' as const, failure: result.failure });
    default: {
      // The remaining arms are the per-write success arms, which differ by name
      // and are mapped rather than assumed: a `kind` this build does not know is
      // NOT read as an applied write.
      const effect = APPLIED_EFFECT_BY_KIND[result.kind];
      return effect === undefined
        ? Object.freeze({ kind: 'unreadable' as const })
        : Object.freeze({ kind: 'applied' as const, effect, item: result.item });
    }
  }
}
