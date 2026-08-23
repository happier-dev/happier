/**
 * The one `state_event` transition sequence, shared by all four GitLab state
 * Actions.
 *
 * GitLab expresses close and reopen — on a merge request and on an issue alike —
 * as `state_event` on the ordinary item update. That is a provider-native
 * transition rather than a replacement of the item's fields: nothing else is
 * sent, so a concurrent edit to the title, description, labels or assignees
 * cannot be overwritten by any of these Actions.
 *
 * What is written once here is the SEQUENCE, because it is the part that must
 * never diverge between four Actions:
 *
 *  1. the fresh read before any effect, and its pin comparison;
 *  2. converge — the requested state already holds, so write nothing;
 *  3. refuse — this item is in a state the transition cannot run from, with the
 *     reason the user is owed and zero writes;
 *  4. write exactly `{ state_event }`;
 *  5. treat a LOST answer as possibly-performed and never as nothing-attempted;
 *  6. prove the outcome with the confirming read, and never from the write's own
 *     status code.
 *
 * Each Action supplies only its own predicates and its own success arm. Four
 * copies of steps 4–6 is the shape this replaces, and the copy that would have
 * lost step 5 is the one that tells a user nothing happened to a close that did.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { buildGitlabItemUrl } from '../detail/routes.js';
import { requestGitlabJson } from '../http/gitlabClient.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import type { GitlabMutationRefusalReasonV1 } from './contracts.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  preflightGitlabItemMutation,
  type GitlabMutationSubjectV1,
} from './preflight.js';

/** The minimum every re-observed row carries. */
type GitlabIdentifiedRow = Readonly<{ iid: string }>;

/**
 * The outcome of one transition, in the Action-neutral spelling.
 *
 * `applied` is deliberately not called `closed` or `reopened`: naming the effect
 * is each Action's own job, and a shared success word is exactly how a reopen
 * would come to be reported as a close.
 */
export type GitlabStateTransitionOutcomeV1<TRow extends GitlabIdentifiedRow> =
  | Readonly<{ kind: 'applied'; item: TRow }>
  | Readonly<{ kind: 'reconfirmationRequired'; observed: TRow }>
  | Readonly<{
    kind: 'refused';
    reason: GitlabMutationRefusalReasonV1;
    dispatched: false;
    observed: TRow;
  }>
  | Readonly<{ kind: 'unconfirmed'; observed?: TRow; failure?: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

export type GitlabStateTransitionV1<TRow extends GitlabIdentifiedRow> = Readonly<{
  stateEvent: 'close' | 'reopen';
  /** The requested state already holds: report it, write nothing. */
  converged: (row: TRow) => boolean;
  /** A state this transition cannot run from, and the reason the user is owed. */
  blocked: (row: TRow) => Readonly<{ reason: GitlabMutationRefusalReasonV1 }> | null;
  /** What the confirming read must show before this transition may be claimed. */
  proven: (row: TRow) => boolean;
}>;

export async function runGitlabStateTransition<TRow extends GitlabIdentifiedRow>(
  input: Readonly<{
    instance: Parameters<typeof preflightGitlabItemMutation>[0]['instance'];
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
    subject: GitlabMutationSubjectV1<TRow>;
    /** Supplied only by the Actions §2.6 gives a pin; omitted where none applies. */
    expectedRevision?: string;
    transition: GitlabStateTransitionV1<TRow>;
  }>,
  context: PluginInvocationContext,
): Promise<GitlabStateTransitionOutcomeV1<TRow>> {
  const preflight = await preflightGitlabItemMutation({
    instance: input.instance,
    localRef: input.localRef,
    subject: input.subject,
    ...(input.expectedRevision === undefined
      ? {}
      : { expectedRevision: input.expectedRevision }),
  }, context);
  if (!preflight.ok) return preflight.refusal;

  if (input.transition.converged(preflight.row)) {
    return { kind: 'applied', item: preflight.row };
  }
  const blocked = input.transition.blocked(preflight.row);
  if (blocked !== null) {
    return {
      kind: 'refused',
      reason: blocked.reason,
      dispatched: false,
      observed: preflight.row,
    };
  }

  const write = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url: buildGitlabItemUrl(preflight.route),
    method: 'PUT',
    // Exactly the transition, and nothing else. GitLab's update also accepts
    // `title`, `description`, `labels`, `assignee_ids` and (on a merge request)
    // `should_remove_source_branch`, and every one of them would REPLACE state
    // this control never asked to touch.
    body: { state_event: input.transition.stateEvent },
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
  if (write.kind === 'failed' && !gitlabWriteAnswerLost(write)) {
    return { kind: 'unavailable', failure: projectGitlabSourceFailure(write.failure) };
  }
  // A write whose answer was lost falls through to the same confirming read a
  // `200` gets: the transition may have run, and `unavailable` would claim
  // nothing was attempted.

  const confirmed = await confirmGitlabItemMutation(preflight);
  if (!confirmed.ok) return { kind: 'unconfirmed', failure: confirmed.failure };
  return input.transition.proven(confirmed.row)
    ? { kind: 'applied', item: confirmed.row }
    : { kind: 'unconfirmed', observed: confirmed.row };
}
