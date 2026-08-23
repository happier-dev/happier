/**
 * What the GitHub detail surface may write, what each write needs, and what its
 * answer means.
 *
 * The three pull-request writes are declared Actions with their own strict inputs
 * (`triage/mutations/contracts.ts`). This module owns only the three decisions the
 * SURFACE has to make around them, and it owns them as plain functions so they can
 * be checked without mounting a device:
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
  GithubPullRequestCloseInputV1Schema,
  GithubPullRequestMergeInputV1Schema,
  type GithubMergeMethodV1,
  type GithubPullRequestCloseInputV1,
  type GithubPullRequestMergeInputV1,
  type GithubPullRequestMergeResultV1,
  type GithubPullRequestStateResultV1,
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

export type GithubPullRequestMutationIdV1 = 'merge' | 'close' | 'reopen';

type ObservedState = TriageDetailSurfaceInputV1['observation']['snapshot']['state'];

const OPEN_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze(['merge', 'close']);
const CLOSED_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze(['reopen']);
const NO_MUTATIONS: readonly GithubPullRequestMutationIdV1[] = Object.freeze([]);

/**
 * The writes this entry offers, from the applied observation alone.
 *
 * All three Actions are pull-request writes, so an issue offers none of them: a
 * control whose every press the provider refuses is worse than no control.
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
  if (params.kindId !== 'pull-request') return NO_MUTATIONS;
  if (params.state.presentation === 'active') return OPEN_MUTATIONS;
  if (params.state.presentation === 'closed') return CLOSED_MUTATIONS;
  // `resolved`, `unknown` and anything a later contract adds state nothing this
  // build can turn into a transition, so it offers nothing rather than guessing.
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
  | Readonly<{ kind: 'refused'; reason: GithubMutationRefusalReasonV1 }>
  | Readonly<{ kind: 'uncertain'; failure: TriageSourceFailureV1 | null }>
  | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'rejected'; code: string; message: string }>
  | Readonly<{ kind: 'unreadable' }>;

export type GithubMutationResultV1 =
  | GithubPullRequestMergeResultV1
  | GithubPullRequestStateResultV1;

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
    return Object.freeze({ kind: 'applied' as const, effect: parsed.effect });
  }
  if (parsed.kind === 'refused') {
    return Object.freeze({ kind: 'refused' as const, reason: parsed.reason });
  }
  if (parsed.kind === 'uncertain') {
    return Object.freeze({
      kind: 'uncertain' as const,
      failure: parsed.failure ?? null,
    });
  }
  return Object.freeze({ kind: 'failed' as const, failure: parsed.failure });
}
