/**
 * What the GitHub detail surface may write, what each write needs, and what its
 * answer means.
 *
 * The writes this surface offers — merge, close and reopen — are declared Actions
 * with their own strict inputs (`triage/mutations/contracts.ts`), one per kind that
 * can take them: five in all, three on a pull request and two on an issue. This
 * module owns only the three decisions the SURFACE has to make around them, and it
 * owns them as plain functions so they can be checked without mounting a device:
 *
 *  1. which writes the applied observation actually offers;
 *  2. how an offered write's input is built from that same observation — and when
 *     it cannot be built at all;
 *  3. what one settled dispatch MEANS, which is not the same question as whether
 *     the dispatch succeeded.
 *
 * (3) is the one worth stating twice. `useExecutePluginAction` settles the
 * TRANSPORT: `success` means the Action ran and returned, not that GitHub changed.
 * The Action's own result union carries the outcome, and it distinguishes a
 * changed state, a state GitHub already held, a refusal this source made from a
 * fresh read, a stated failure, and an accepted request whose effect could not be
 * confirmed. Flattening any of those into "it worked" or "it failed" is how a
 * duplicate merge ships, so this projection keeps all of them apart.
 *
 * Nothing here reads a provider, holds a credential, or re-decides policy. Every
 * input is parsed by the write contract's own schema before it is offered to the
 * host, so this module cannot invent a shape the Action would then have to reject.
 */

import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import type {
  TriageDetailSurfaceInputV1,
  TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import {
  GithubIssueAssigneeAddInputV1Schema,
  GithubIssueAssigneeRemoveInputV1Schema,
  GithubIssueCloseInputV1Schema,
  GithubIssueDeltaResultV1Schema,
  GithubIssueLabelAddInputV1Schema,
  GithubIssueLabelRemoveInputV1Schema,
  GithubIssueReopenInputV1Schema,
  GithubPullRequestAddReviewersInputV1Schema,
  GithubPullRequestCloseInputV1Schema,
  GithubPullRequestMarkReadyInputV1Schema,
  GithubPullRequestMarkReadyResultV1Schema,
  GithubPullRequestMergeInputV1Schema,
  GithubPullRequestReviewPublicationInputV1Schema,
  GithubPullRequestRemoveReviewersInputV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestThreadResolutionInputV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestUpdateBranchInputV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
  type GithubIssueAssigneeAddInputV1,
  type GithubIssueAssigneeRemoveInputV1,
  type GithubIssueCloseInputV1,
  type GithubIssueCloseReasonV1,
  type GithubIssueDeltaResultV1,
  type GithubIssueLabelAddInputV1,
  type GithubIssueLabelRemoveInputV1,
  type GithubIssueReopenInputV1,
  type GithubMergeMethodV1,
  type GithubPullRequestAddReviewersInputV1,
  type GithubPullRequestCloseInputV1,
  type GithubPullRequestMarkReadyInputV1,
  type GithubPullRequestMarkReadyResultV1,
  type GithubPullRequestMergeInputV1,
  type GithubPullRequestMergeResultV1,
  type GithubPullRequestReviewPublicationInputV1,
  type GithubPullRequestReviewPublicationResultV1,
  type GithubPullRequestReviewVerdictV1,
  type GithubPullRequestRemoveReviewersInputV1,
  type GithubPullRequestReviewersResultV1,
  type GithubPullRequestStateResultV1,
  type GithubPullRequestThreadResolutionInputV1,
  type GithubPullRequestThreadResolutionResultV1,
  type GithubPullRequestUpdateBranchInputV1,
  type GithubPullRequestUpdateBranchResultV1,
} from '../../triage/mutations/contracts.js';
import type { GithubTriageKindIdV1 } from '../../triage/types.js';

/**
 * GitHub's own merge-method vocabulary, in the order the chooser offers it.
 *
 * Typed against the contract's union so a method added or renamed there fails this
 * build rather than silently disappearing from the chooser. Which of the three a
 * repository actually allows is not knowable from here — a repository that forbids
 * one answers `merge_method_not_allowed`, and that refusal is rendered as itself.
 */
export const GITHUB_MERGE_METHODS_V1: readonly GithubMergeMethodV1[] = Object.freeze([
  'merge',
  'squash',
  'rebase',
]);

/**
 * What a reader may do to the entry in front of them, in this product's words.
 *
 * `close` and `reopen` are ONE offer each across both kinds because they are one
 * thing to the person pressing them. They are two different Actions underneath —
 * closing an issue takes a reason and closing a pull request does not — and the
 * renderer resolves which from the kind. Splitting the offer per kind would make
 * every caller re-derive the same state rule twice.
 */
export type GithubPullRequestMutationIdV1 = 'merge' | 'close' | 'reopen';

type ObservedState = TriageDetailSurfaceInputV1['observation']['snapshot']['state'];

const OPEN_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze(['merge', 'close']);
const ISSUE_OPEN_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze(['close']);
const CLOSED_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze(['reopen']);
const NO_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze([]);

/**
 * The writes this entry offers, from the applied observation alone.
 *
 * An issue offers `close` and `reopen` but never `merge`, because GitHub has no
 * merge to refuse there: a control whose every press the provider refuses is worse
 * than no control.
 *
 * The branch is on the projected `presentation` state and never on `nativeLabel`.
 * The native label is GitHub's own word kept for display, and deciding what a user
 * may write from display text would make one relabelled string change behaviour.
 * A closed pull request therefore offers `reopen` whether or not it was merged;
 * a merged one is refused `state_changed` by the write's own fresh read, which is
 * the answer that source was built to give and the one that stays true.
 */
export function githubOfferedMutationsV1(params: Readonly<{
  kindId: GithubTriageKindIdV1;
  state: ObservedState;
}>): readonly GithubPullRequestMutationIdV1[] {
  // `resolved`, `unknown` and anything a later contract adds state nothing this
  // build can turn into a transition, so they offer nothing rather than guessing.
  if (params.kindId === 'issue') {
    // An issue cannot be merged, and GitHub closes one as completed, not planned
    // or duplicate — a reason the reader supplies, not one this build picks.
    if (params.state.presentation === 'active') return ISSUE_OPEN_MUTATIONS;
    return params.state.presentation === 'closed' ? CLOSED_MUTATIONS : NO_MUTATIONS;
  }
  if (params.kindId !== 'pull-request') return NO_MUTATIONS;
  if (params.state.presentation === 'active') return OPEN_MUTATIONS;
  if (params.state.presentation === 'closed') return CLOSED_MUTATIONS;
  return NO_MUTATIONS;
}
/**
 * The target shape every GitHub write names: the configured instance whose account
 * is rematerialized for the invocation, the canonical entry ref, and the
 * source-private route the target observed for THIS entry.
 *
 * Parsed through the close contract because that contract IS the shared target —
 * close and reopen declare the identical closed shape, so one built value serves
 * both rather than two builders that could drift apart. Each Action still parses
 * the value against its own schema at the daemon.
 *
 * `null` when the observation carries no route. A path is never guessed from
 * identity, display text or a git remote.
 */
export function buildGithubPullRequestTargetInputV1(
  input: TriageDetailSurfaceInputV1,
): GithubPullRequestCloseInputV1 | null {
  const parsed = GithubPullRequestCloseInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The merge input, carrying the head the USER is looking at.
 *
 * The revision comes from the applied observation and from nowhere else: its whole
 * value as a precondition is that it is the head the decision was made against, so
 * a fresh read at press time would defeat the guarantee it exists to provide. An
 * observation with no revision, or one whose identifier is not a commit object the
 * write contract accepts, builds nothing — the control then says the head is
 * unknown instead of dispatching a write that can only fail.
 *
 * The method is a caller argument with no default here and none in the contract.
 * Choosing one on the user's behalf would pick how their history is rewritten.
 */
export function buildGithubPullRequestMergeInputV1(
  input: TriageDetailSurfaceInputV1,
  mergeMethod: GithubMergeMethodV1,
): GithubPullRequestMergeInputV1 | null {
  const parsed = GithubPullRequestMergeInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
    headRevision: input.observation.nativeRevision,
    mergeMethod,
  });
  return parsed.success ? parsed.data : null;
}

/** The two head-pinned pull-request transitions share the observed-head source. */
export function buildGithubPullRequestMarkReadyInputV1(
  input: TriageDetailSurfaceInputV1,
): GithubPullRequestMarkReadyInputV1 | null {
  const parsed = GithubPullRequestMarkReadyInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    headRevision: input.observation.nativeRevision,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestUpdateBranchInputV1(
  input: TriageDetailSurfaceInputV1,
): GithubPullRequestUpdateBranchInputV1 | null {
  const parsed = GithubPullRequestUpdateBranchInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    headRevision: input.observation.nativeRevision,
  });
  return parsed.success ? parsed.data : null;
}

/** Builds the one head-pinned review publication request from visible user input. */
export function buildGithubPullRequestReviewPublicationInputV1(
  input: TriageDetailSurfaceInputV1,
  verdict: GithubPullRequestReviewVerdictV1,
  summary: string,
): GithubPullRequestReviewPublicationInputV1 | null {
  const parsed = GithubPullRequestReviewPublicationInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    headRevision: input.observation.nativeRevision,
    verdict,
    summary,
  });
  return parsed.success ? parsed.data : null;
}

/** GitHub login/team inputs cannot contain whitespace, so pasted separators are unambiguous. */
export function readGithubNamesV1(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/u).map((name) => name.trim()).filter(Boolean))];
}

/** Labels may contain spaces and punctuation, including commas; one line therefore means one label. */
export function readGithubLabelsV1(value: string): readonly string[] {
  return [...new Set(value.split(/\r?\n/u).map((label) => label.trim()).filter(Boolean))];
}

export function buildGithubPullRequestReviewersInputV1(
  input: TriageDetailSurfaceInputV1,
  users: readonly string[],
  teams: readonly string[],
  direction: 'add' | 'remove',
): GithubPullRequestAddReviewersInputV1 | GithubPullRequestRemoveReviewersInputV1 | null {
  if (users.length === 0 && teams.length === 0) return null;
  const candidate = {
    ...mutationTargetOf(input),
    ...(users.length === 0 ? {} : { users }),
    ...(teams.length === 0 ? {} : { teams }),
  };
  const schema = direction === 'add'
    ? GithubPullRequestAddReviewersInputV1Schema
    : GithubPullRequestRemoveReviewersInputV1Schema;
  const parsed = schema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestThreadResolutionInputV1(
  input: TriageDetailSurfaceInputV1,
  threadId: string,
  resolved: boolean,
): GithubPullRequestThreadResolutionInputV1 | null {
  const parsed = GithubPullRequestThreadResolutionInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    threadId: threadId.trim(),
    resolved,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * GitHub's own closing reasons, in the order the chooser offers them.
 *
 * Typed against the contract's union so a reason added or renamed there fails
 * this build rather than silently disappearing from the chooser. There is no
 * default: `completed` and `not_planned` are different statements about the same
 * issue, and picking one on the reader's behalf puts words in their mouth in a
 * place everyone watching the issue can read.
 */
export const GITHUB_ISSUE_CLOSE_REASONS_V1: readonly GithubIssueCloseReasonV1[] =
  Object.freeze(['completed', 'not_planned', 'duplicate']);

/**
 * The issue close input, carrying the reason the reader chose.
 *
 * `null` when the observation carries no route, exactly as the pull-request
 * target builder is: a path is never guessed from identity, display text or a
 * git remote.
 */
export function buildGithubIssueCloseInputV1(
  input: TriageDetailSurfaceInputV1,
  stateReason: GithubIssueCloseReasonV1,
): GithubIssueCloseInputV1 | null {
  const parsed = GithubIssueCloseInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
    stateReason,
  });
  return parsed.success ? parsed.data : null;
}

/** Reopening an issue names no reason: GitHub sets `reopened` itself. */
export function buildGithubIssueReopenInputV1(
  input: TriageDetailSurfaceInputV1,
): GithubIssueReopenInputV1 | null {
  const parsed = GithubIssueReopenInputV1Schema.safeParse({
    v: 1,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubIssueAssigneesInputV1(
  input: TriageDetailSurfaceInputV1,
  usernames: readonly string[],
  direction: 'add' | 'remove',
): GithubIssueAssigneeAddInputV1 | GithubIssueAssigneeRemoveInputV1 | null {
  const schema = direction === 'add'
    ? GithubIssueAssigneeAddInputV1Schema
    : GithubIssueAssigneeRemoveInputV1Schema;
  const parsed = schema.safeParse({ ...mutationTargetOf(input), usernames });
  return parsed.success ? parsed.data : null;
}

export function buildGithubIssueLabelsInputV1(
  input: TriageDetailSurfaceInputV1,
  labels: readonly string[],
  direction: 'add' | 'remove',
): GithubIssueLabelAddInputV1 | GithubIssueLabelRemoveInputV1 | null {
  const parsed = direction === 'add'
    ? GithubIssueLabelAddInputV1Schema.safeParse({ ...mutationTargetOf(input), labels })
    : GithubIssueLabelRemoveInputV1Schema.safeParse({
      ...mutationTargetOf(input),
      label: labels.length === 1 ? labels[0] : undefined,
    });
  return parsed.success ? parsed.data : null;
}

function mutationTargetOf(input: TriageDetailSurfaceInputV1) {
  return {
    v: 1 as const,
    instance: input.instance,
    localRef: localRefOf(input),
    routingToken: input.observation.locator.routingToken,
  };
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
 * What one settled write means to the reader.
 *
 * `uncertain` is a first-class member rather than a flavour of failure, and it is
 * reached from two directions that mean the same thing: the Action reported an
 * accepted request it could not confirm, or the dispatch itself settled with an
 * unknown outcome. Both may already have mutated GitHub, so neither may be
 * presented as something to simply press again.
 */
export type GithubMutationOutcomeV1 =
  | Readonly<{ kind: 'applied'; effect: 'changed' | 'alreadySatisfied' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'refused'; reason: GithubMutationRefusalReasonV1 }>
  | Readonly<{ kind: 'uncertain'; failure: TriageSourceFailureV1 | null }>
  | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'rejected'; code: string; message: string }>
  | Readonly<{ kind: 'unreadable' }>;

export type GithubMutationResultV1 =
  | GithubPullRequestMergeResultV1
  | GithubPullRequestReviewPublicationResultV1
  | GithubPullRequestStateResultV1
  | GithubPullRequestMarkReadyResultV1
  | GithubPullRequestUpdateBranchResultV1
  | GithubPullRequestReviewersResultV1
  | GithubIssueDeltaResultV1
  | GithubPullRequestThreadResolutionResultV1;

export type GithubMutationRefusalReasonV1 =
  Extract<GithubMutationResultV1, { kind: 'refused' }>['reason'];

/**
 * Projects one dispatch into the outcome a panel renders.
 *
 * `parsed` is the write result already read through its own Action schema, or
 * `null` when it could not be. A `success` dispatch with an unreadable result is
 * NOT an applied write: the Action returned, and this build cannot say what it
 * returned as. Saying "merged" there would be an invention.
 *
 * Returns `null` while the control is at rest or in flight, because those are
 * states the control itself already shows and not settled facts to report.
 */
export function projectGithubMutationOutcomeV1(
  execution: PluginActionExecution<unknown>,
  parsed: GithubMutationResultV1 | null,
): GithubMutationOutcomeV1 | null {
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') {
    return Object.freeze({ kind: 'uncertain' as const, failure: null });
  }
  if (execution.status === 'error') {
    return Object.freeze({
      kind: 'rejected' as const,
      code: execution.code,
      message: execution.message,
    });
  }
  if (parsed === null) return Object.freeze({ kind: 'unreadable' as const });
  if (parsed.kind === 'applied') {
    return Object.freeze({
      kind: 'applied' as const,
      effect: 'effect' in parsed ? parsed.effect : 'changed',
    });
  }
  if (parsed.kind === 'pending') return Object.freeze({ kind: 'pending' as const });
  if (parsed.kind === 'refused') {
    return Object.freeze({ kind: 'refused' as const, reason: parsed.reason });
  }
  if (parsed.kind === 'uncertain') {
    return Object.freeze({
      kind: 'uncertain' as const,
      failure: parsed.failure ?? null,
    });
  }
  if (parsed.kind === 'rejected') {
    return Object.freeze({
      kind: 'rejected' as const,
      code: parsed.reason,
      message: parsed.reason,
    });
  }
  return Object.freeze({ kind: 'failed' as const, failure: parsed.failure });
}

/** Whether GitHub's own settled write vocabulary leaves provider state uncertain. */
export function githubMutationMayHaveChangedProviderStateV1(
  outcome: GithubMutationOutcomeV1 | null,
): boolean {
  if (outcome === null) return false;
  switch (outcome.kind) {
    case 'applied':
      return outcome.effect === 'changed';
    case 'pending':
    case 'uncertain':
    case 'unreadable':
      return true;
    default:
      return false;
  }
}
