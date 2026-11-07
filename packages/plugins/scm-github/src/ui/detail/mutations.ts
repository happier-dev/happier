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
 *  3. host transport settlement around the source-owned outcome. Native meaning
 *     lives in `triage/mutations/outcome.ts`, including original Action feedback.
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
import type { ReviewCommentPublicationPlanV1 } from '@happier-dev/plugin-sdk/reviews';
import type {
  TriageDetailSurfaceInputV1,
} from '@happier-dev/triage-protocol/v1';

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
  GithubPullRequestReviewCommentCreateInputV1Schema,
  GithubPullRequestReviewPublicationInputV1Schema,
  GithubPullRequestThreadReplyInputV1Schema,
  GithubPullRequestRemoveReviewersInputV1Schema,
  GithubPullRequestThreadResolutionInputV1Schema,
  GithubPullRequestUpdateBranchInputV1Schema,
  GithubCommentEditInputV1Schema,
  GithubCommentCreateInputV1Schema,
  type GithubCommentCreateInputV1,
  type GithubCommentEditInputV1,
  type GithubCommentEditTargetKindV1,
  type GithubIssueAssigneeAddInputV1,
  type GithubIssueAssigneeRemoveInputV1,
  type GithubIssueCloseInputV1,
  type GithubIssueCloseReasonV1,
  type GithubIssueLabelAddInputV1,
  type GithubIssueLabelRemoveInputV1,
  type GithubIssueReopenInputV1,
  type GithubPullRequestAddReviewersInputV1,
  type GithubPullRequestCloseInputV1,
  type GithubPullRequestReviewCommentCreateInputV1,
  type GithubPullRequestReviewPublicationInputV1,
  type GithubPullRequestRemoveReviewersInputV1,
  type GithubPullRequestThreadResolutionInputV1,
  type GithubPullRequestUpdateBranchInputV1,
  GithubPullRequestEditInputV1Schema,
  GithubPullRequestChangeBaseInputV1Schema,
  GithubPullRequestConvertToDraftInputV1Schema,
  GithubEntryMilestoneSetInputV1Schema,
  GithubIssueTypeSetInputV1Schema,
  GithubEntryLockInputV1Schema,
  GITHUB_LOCK_REASONS_V1,
  GithubEntryUnlockInputV1Schema,
  GithubPullRequestHeadBranchDeleteInputV1Schema,
  GithubIssueTransferInputV1Schema,
  GithubPullRequestRevertInputV1Schema,
  GithubPullRequestPendingReviewCreateInputV1Schema,
  GithubPullRequestPendingReviewSubmitInputV1Schema,
  GithubPullRequestPendingReviewDeleteInputV1Schema,
  GithubPullRequestReviewDismissInputV1Schema,
  type GithubPullRequestReviewVerdictV1,
} from '../../triage/mutations/contracts.js';
import {
  GithubRelatedEntryInputV1Schema,
  GithubSubIssueAddInputV1Schema,
} from '../../triage/mutations/relationshipContracts.js';
import type { GithubTriageKindIdV1 } from '../../triage/types.js';
import type { GithubSecurityAlertMutationResultV1 } from '../../triage/securityAlerts/actionContracts.js';

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
 * A merged pull request projects `resolved` (`CONTRACT.md` §4, r0.42) and can
 * never be reopened, so it offers no guaranteed refusal; one closed without
 * merging projects `closed` and offers reopen. Issue `resolved` is GitHub's
 * canonical completed-issue presentation and remains reopenable just like its
 * other closed reasons.
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
    return params.state.presentation === 'closed' || params.state.presentation === 'resolved'
      ? CLOSED_MUTATIONS
      : NO_MUTATIONS;
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

export function buildGithubPullRequestUpdateBranchInputV1(
  input: TriageDetailSurfaceInputV1,
): GithubPullRequestUpdateBranchInputV1 | null {
  const parsed = GithubPullRequestUpdateBranchInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    headRevision: input.observation.snapshot.reviewRevision?.headSha,
  });
  return parsed.success ? parsed.data : null;
}

/** Builds the one head-pinned review publication request from visible user input. */
export function buildGithubPullRequestReviewPublicationInputV1(
  input: TriageDetailSurfaceInputV1,
  publicationPlan: ReviewCommentPublicationPlanV1,
): GithubPullRequestReviewPublicationInputV1 | null {
  const parsed = GithubPullRequestReviewPublicationInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestReviewCommentCreateInputV1(
  input: TriageDetailSurfaceInputV1,
  publicationPlan: ReviewCommentPublicationPlanV1,
): GithubPullRequestReviewCommentCreateInputV1 | null {
  const parsed = GithubPullRequestReviewCommentCreateInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestThreadReplyInputV1(
  input: TriageDetailSurfaceInputV1,
  publicationPlan: ReviewCommentPublicationPlanV1,
  threadId: string,
) {
  const target = buildGithubPullRequestTargetInputV1(input);
  if (target === null) return null;
  const parsed = GithubPullRequestThreadReplyInputV1Schema.safeParse({
    ...target,
    publicationPlan,
    threadId,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubIssueCommentInputV1(
  input: TriageDetailSurfaceInputV1,
  publicationPlan: ReviewCommentPublicationPlanV1,
) {
  const parsed = GithubIssueCommentInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    publicationPlan,
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

/** One new conversation comment on this entry, or `null` for an empty body. */
export function buildGithubCommentCreateInputV1(
  input: TriageDetailSurfaceInputV1,
  body: string,
): GithubCommentCreateInputV1 | null {
  if (body.trim() === '') return null;
  const parsed = GithubCommentCreateInputV1Schema.safeParse({ ...mutationTargetOf(input), body });
  return parsed.success ? parsed.data : null;
}

/** The exact edit of one comment body on this entry, or `null` for an empty body. */
export function buildGithubCommentEditInputV1(
  input: TriageDetailSurfaceInputV1,
  target: Readonly<{ kind: GithubCommentEditTargetKindV1; id: string }>,
  body: string,
): GithubCommentEditInputV1 | null {
  if (body.trim() === '') return null;
  const parsed = GithubCommentEditInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    target: { kind: target.kind, id: target.id },
    body,
  });
  return parsed.success ? parsed.data : null;
}

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

/** Only the fields the reader changed: an untouched title or description is never resent. */
export function buildGithubPullRequestEditInputV1(
  input: TriageDetailSurfaceInputV1,
  edited: Readonly<{ title?: string; body?: string }>,
) {
  const parsed = GithubPullRequestEditInputV1Schema.safeParse({ ...mutationTargetOf(input), ...edited });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestChangeBaseInputV1(input: TriageDetailSurfaceInputV1, baseBranch: string) {
  const parsed = GithubPullRequestChangeBaseInputV1Schema.safeParse({ ...mutationTargetOf(input), baseBranch: baseBranch.trim() });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestConvertToDraftInputV1(input: TriageDetailSurfaceInputV1) {
  const parsed = GithubPullRequestConvertToDraftInputV1Schema.safeParse(mutationTargetOf(input));
  return parsed.success ? parsed.data : null;
}

/** A milestone is named by its number; `null` clears it. */
export function buildGithubEntryMilestoneSetInputV1(input: TriageDetailSurfaceInputV1, milestone: number | null) {
  const parsed = GithubEntryMilestoneSetInputV1Schema.safeParse({ ...mutationTargetOf(input), milestone });
  return parsed.success ? parsed.data : null;
}

/** An issue type is named as GitHub names it; `null` clears it. */
export function buildGithubIssueTypeSetInputV1(input: TriageDetailSurfaceInputV1, issueType: string | null) {
  const parsed = GithubIssueTypeSetInputV1Schema.safeParse({
    ...mutationTargetOf(input), issueType: issueType === null ? null : issueType.trim(),
  });
  return parsed.success ? parsed.data : null;
}

export { GITHUB_LOCK_REASONS_V1 } from '../../triage/mutations/contracts.js';
export type GithubLockReasonV1 = typeof GITHUB_LOCK_REASONS_V1[number];

export function buildGithubEntryLockInputV1(input: TriageDetailSurfaceInputV1, reason: GithubLockReasonV1 | null) {
  const parsed = GithubEntryLockInputV1Schema.safeParse({
    ...mutationTargetOf(input), ...(reason === null ? {} : { reason }),
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubEntryUnlockInputV1(input: TriageDetailSurfaceInputV1) {
  const parsed = GithubEntryUnlockInputV1Schema.safeParse(mutationTargetOf(input));
  return parsed.success ? parsed.data : null;
}

/** Delete and Restore both name the head the reader saw; neither is filled from a fresh read. */
export function buildGithubPullRequestHeadBranchInputV1(input: TriageDetailSurfaceInputV1, headRevision: string | undefined) {
  const parsed = GithubPullRequestHeadBranchDeleteInputV1Schema.safeParse({ ...mutationTargetOf(input), headRevision });
  return parsed.success ? parsed.data : null;
}

export function buildGithubIssueTransferInputV1(input: TriageDetailSurfaceInputV1,
  destinationRepository: string, createLabelsIfMissing: boolean) {
  const parsed = GithubIssueTransferInputV1Schema.safeParse({
    ...mutationTargetOf(input), destinationRepository, createLabelsIfMissing,
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPullRequestRevertInputV1(input: TriageDetailSurfaceInputV1,
  fields: Readonly<{ title: string; body?: string; draft: boolean }>) {
  const parsed = GithubPullRequestRevertInputV1Schema.safeParse({ ...mutationTargetOf(input), ...fields });
  return parsed.success ? parsed.data : null;
}

/**
 * The reader's "#123" in this entry's own repository, as the exact related entry a relationship Action names.
 * The kind is the Action's (an issue for sub-issues and dependencies, the other kind for a closing reference);
 * GitHub's own identity read still proves it. Another repository's entry is not guessed from a bare number.
 */
export function readGithubSameRepositoryNumberV1(value: string): string | null {
  const match = /^#?([1-9][0-9]*)$/u.exec(value.trim());
  return match?.[1] ?? null;
}

export function buildGithubRelatedEntryInputV1(
  input: TriageDetailSurfaceInputV1,
  relatedKindId: GithubTriageKindIdV1,
  number: string | null,
) {
  if (number === null) return null;
  const parsed = GithubRelatedEntryInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    related: {
      localRef: { kindId: relatedKindId, collisionScope: input.observation.entryRef.collisionScope, entryId: number },
      routingToken: input.observation.locator.routingToken,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubSubIssueAddInputV1(input: TriageDetailSurfaceInputV1, number: string | null) {
  const related = buildGithubRelatedEntryInputV1(input, 'issue', number);
  if (related === null) return null;
  const parsed = GithubSubIssueAddInputV1Schema.safeParse(related);
  return parsed.success ? parsed.data : null;
}

/** Creates GitHub's pending review at the head the reader saw; the summary is optional. */
export function buildGithubPendingReviewCreateInputV1(input: TriageDetailSurfaceInputV1, body: string) {
  const parsed = GithubPullRequestPendingReviewCreateInputV1Schema.safeParse({
    ...mutationTargetOf(input),
    headRevision: input.observation.snapshot.reviewRevision?.headSha,
    ...(body.trim() === '' ? {} : { body }),
  });
  return parsed.success ? parsed.data : null;
}

/** Submits the viewer's own pending review against the head the reader saw, with the verdict they chose. */
export function buildGithubPendingReviewSubmitInputV1(
  input: TriageDetailSurfaceInputV1,
  reviewId: string,
  verdict: GithubPullRequestReviewVerdictV1,
  body: string,
) {
  const parsed = GithubPullRequestPendingReviewSubmitInputV1Schema.safeParse({
    ...mutationTargetOf(input), reviewId, verdict,
    headRevision: input.observation.snapshot.reviewRevision?.headSha,
    ...(body.trim() === '' ? {} : { body }),
  });
  return parsed.success ? parsed.data : null;
}

export function buildGithubPendingReviewDeleteInputV1(input: TriageDetailSurfaceInputV1, reviewId: string) {
  const parsed = GithubPullRequestPendingReviewDeleteInputV1Schema.safeParse({ ...mutationTargetOf(input), reviewId });
  return parsed.success ? parsed.data : null;
}

/** GitHub requires a reason to dismiss a submitted review; there is no default one. */
export function buildGithubReviewDismissInputV1(input: TriageDetailSurfaceInputV1, reviewId: string, message: string) {
  if (message.trim() === '') return null;
  const parsed = GithubPullRequestReviewDismissInputV1Schema.safeParse({ ...mutationTargetOf(input), reviewId, message });
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
  if (entryRef.kindId !== 'issue' && entryRef.kindId !== 'pull-request') return undefined;
  return {
    kindId: entryRef.kindId,
    collisionScope: entryRef.collisionScope,
    entryId: entryRef.entryId,
  };
}

export type {
  GithubMutationOutcomeV1, GithubMutationResultV1, GithubMutationRefusalReasonV1,
  GithubSecurityAlertMutationOutcomeV1,
} from '../../triage/mutations/outcome.js';
export { githubMutationMayHaveChangedProviderStateV1 } from '../../triage/mutations/outcome.js';

import {
  projectGithubMutationOutcomeV1 as projectNativeOutcome,
  type GithubMutationOutcomeV1, type GithubMutationResultV1, type GithubSecurityAlertMutationOutcomeV1,
} from '../../triage/mutations/outcome.js';

/** Transport settlement stays host-owned; actual native Actions carry their projected outcome. */
export function projectGithubMutationOutcomeV1(
  execution: PluginActionExecution<unknown>,
  parsed: GithubMutationResultV1 | null,
): GithubMutationOutcomeV1 | null;
export function projectGithubMutationOutcomeV1(
  execution: PluginActionExecution<unknown>,
  parsed: GithubSecurityAlertMutationResultV1 | null,
): GithubSecurityAlertMutationOutcomeV1 | null;
export function projectGithubMutationOutcomeV1(
  execution: PluginActionExecution<unknown>,
  parsed: GithubMutationResultV1 | GithubSecurityAlertMutationResultV1 | null,
): GithubMutationOutcomeV1 | GithubSecurityAlertMutationOutcomeV1 | null {
  if (execution.status === 'idle' || execution.status === 'pending') return null;
  if (execution.status === 'outcomeUnknown') return Object.freeze({ kind: 'uncertain', failure: null });
  if (execution.status === 'error') return Object.freeze({ kind: 'rejected', code: execution.code, message: execution.message });
  if (parsed === null) return Object.freeze({ kind: 'unreadable' });
  if ('outcome' in parsed) return parsed.outcome;
  return projectNativeOutcome(parsed);
}
