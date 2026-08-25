/**
 * The fresh currentness read every GitLab mutation performs before it writes.
 *
 * `sources/SCM.md` §2.8: cached corpus bytes never authorize a mutation. Every
 * exact SCM Action reauthorizes the selected configured account, reconstructs
 * routing only from the source-owned reference, and rereads the current provider
 * entity and revision before any effect.
 *
 * It is a currentness and permission preflight, **not** a claim that a
 * client-side read serializes the later write. Where GitLab exposes a native
 * precondition — the merge endpoint's `sha` — the pin is also sent as that
 * precondition; where it does not, the rule is read, compare, refuse before
 * writing.
 *
 * The pin itself is never produced here. §2.6 forbids filling it from a fresh
 * read at write time: the field's whole value is that it comes from the read the
 * **user** acted on, and re-deriving it is the exact race it exists to close.
 *
 * **One preflight serves both entry kinds, and there is no kind branch in it.**
 * What differs between a merge request and an issue is which endpoint the item
 * lives at, how its row decodes, and which of its facts a caller's pin is
 * compared against — three facts each kind states once, in its own subject
 * descriptor. A second preflight for issues would be a second owner of *read
 * before effect, prove identity, compare the pin, refuse*, and the copy that
 * later lost the identity check would be the one nobody reread.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { admitGitlabItemInvocation } from '../admission.js';
import { buildGitlabItemUrl } from '../detail/routes.js';
import type { GitlabDetailReadDependenciesV1 } from '../detail/reads.js';
import type { GitlabDetailRouteInputV1 } from '../detail/routes.js';
import { requestGitlabJson, type GitlabRequestResult } from '../http/gitlabClient.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import type { GitlabKindId } from '../types.js';

export const GITLAB_MUTATION_INPUT_INVALID_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-mutation-input-invalid',
});

const UNDECODABLE_ITEM_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'undecodable-item',
  detail: 'The GitLab entry could not be identified before the write.',
});

const IDENTITY_MISMATCH_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'identity-mismatch',
  detail: 'GitLab answered with an entry other than the one addressed.',
});

/**
 * GitLab answers a hidden, confidential and removed item identically, so a
 * mutation never reads a `404` as *gone*. It refuses, and the row survives.
 */
const ITEM_UNREADABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'permission',
  code: 'item-unreadable',
  detail: 'GitLab answers a hidden, confidential and removed item identically.',
});

/** The minimum every re-observed row carries: the identity the write addressed. */
type GitlabIdentifiedRow = Readonly<{ projectId: number; iid: string }>;

export function gitlabMutationRowMatchesRouteV1(
  row: GitlabIdentifiedRow,
  route: Readonly<{ projectId: number; iid: string }>,
): boolean {
  return row.projectId === route.projectId && row.iid === route.iid;
}

/**
 * Everything a mutation needs to know about the KIND it addresses, stated once
 * per kind instead of branched on per Action.
 */
export type GitlabMutationSubjectV1<TRow extends GitlabIdentifiedRow> = Readonly<{
  /** The only kind this subject admits; anything else is refused before a read. */
  kindId: GitlabKindId;
  decode: (body: unknown) => Readonly<{ ok: true; row: TRow }> | Readonly<{ ok: false }>;
  /**
   * The fact a caller's pin is compared against — a merge request's head commit,
   * an issue's `updated_at`. `undefined` means this fresh read cannot see it,
   * which never compares equal to a pin.
   */
  observedPin: (row: TRow) => string | undefined;
}>;

/** The two ways a mutation ends before anything is written. */
export type GitlabMutationPreflightRefusal<TRow extends GitlabIdentifiedRow> =
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>
  | Readonly<{ kind: 'reconfirmationRequired'; observed: TRow }>;

export type GitlabMutationPreflight<TRow extends GitlabIdentifiedRow> =
  | Readonly<{
    ok: true;
    route: GitlabDetailRouteInputV1;
    dependencies: GitlabDetailReadDependenciesV1;
    subject: GitlabMutationSubjectV1<TRow>;
    /** The current item, as this invocation just observed it. */
    row: TRow;
    /** The raw body, for the one fact no projected row carries: the project path. */
    body: unknown;
  }>
  | Readonly<{ ok: false; refusal: GitlabMutationPreflightRefusal<TRow> }>;

function unavailable<TRow extends GitlabIdentifiedRow>(
  failure: TriageSourceFailureV1,
): GitlabMutationPreflight<TRow> {
  return Object.freeze({
    ok: false as const,
    refusal: Object.freeze({ kind: 'unavailable' as const, failure }),
  });
}

/**
 * Reads the entry this invocation addresses and proves it is still the one the
 * user acted on.
 *
 * `expectedRevision` is supplied only by the Actions §2.6 pins. `close` and
 * `reopen` omit it because both transitions are head-independent, and carrying a
 * pin there would add a failure mode that protects no invariant — a
 * collaborator's push would refuse a close that nothing invalidated. An unpinned
 * mutation is therefore admitted here on purpose; the state gate each Action
 * applies to `row.state` is what those transitions are owed, and it is the one
 * that answers the question they actually ask.
 */
export async function preflightGitlabItemMutation<TRow extends GitlabIdentifiedRow>(
  input: Readonly<{
    instance: Parameters<typeof admitGitlabItemInvocation>[0]['instance'];
    localRef: Readonly<{ kindId: string; entryId: string; collisionScope: string }>;
    subject: GitlabMutationSubjectV1<TRow>;
    expectedRevision?: string;
  }>,
  context: PluginInvocationContext,
): Promise<GitlabMutationPreflight<TRow>> {
  const admitted = await admitGitlabItemInvocation({
    instance: input.instance,
    localRef: input.localRef,
    // This Action transitions one kind. A reference of the other kind is refused
    // here rather than routed into the wrong endpoints — a GitLab issue and a
    // GitLab merge request can share a project and an IID, so the wrong route
    // would transition a different item that looks right in every later check.
    admissibleKinds: [input.subject.kindId],
  }, context);
  if (!admitted.ok) return unavailable(admitted.failure);

  const read = await requestGitlabJson({
    invocation: admitted.dependencies.invocation,
    url: buildGitlabItemUrl(admitted.route),
    fetcher: admitted.dependencies.fetcher,
    signal: admitted.dependencies.signal,
    nowMs: admitted.dependencies.nowMs,
  });
  if (read.kind === 'failed') {
    return unavailable(read.failure.code === 'not-found'
      ? ITEM_UNREADABLE_FAILURE
      : projectGitlabSourceFailure(read.failure));
  }

  const decoded = input.subject.decode(read.response.body);
  if (!decoded.ok) return unavailable(UNDECODABLE_ITEM_FAILURE);
  if (!gitlabMutationRowMatchesRouteV1(decoded.row, admitted.route)) {
    return unavailable(IDENTITY_MISMATCH_FAILURE);
  }

  // The pin is compared only when the Action carries one, and it is compared
  // against the value this fresh read observed. An item whose pinned fact GitLab
  // now reports as absent does NOT compare equal to a pin:
  // `undefined !== '<value>'` refuses, which is the honest answer for a fact this
  // invocation cannot see.
  const pinMoved = input.expectedRevision !== undefined
    && input.subject.observedPin(decoded.row) !== input.expectedRevision;
  if (pinMoved) {
    // Show the delta and require explicit reconfirmation. Writing anyway decides
    // on the user's behalf; doing nothing silently is worse still, because they
    // believe the write happened.
    return Object.freeze({
      ok: false as const,
      refusal: Object.freeze({
        kind: 'reconfirmationRequired' as const,
        observed: decoded.row,
      }),
    });
  }

  return Object.freeze({
    ok: true as const,
    route: admitted.route,
    dependencies: admitted.dependencies,
    subject: input.subject,
    row: decoded.row,
    body: read.response.body,
  });
}

/**
 * The failures that mean the request left this process and GitLab's answer did
 * not come back: a dropped connection, a cancelled invocation, this source's own
 * deadline elapsing, and a body this client could not decode — which is a **2xx**
 * GitLab already acted on.
 *
 * It is a positive list rather than "no status", because the absence of a status
 * also covers the two refusals this client makes before dispatch, and reading a
 * never-sent request as possibly-performed would be the opposite error.
 *
 * `deadline-exceeded` belongs here for exactly the reason `cancelled` does, and
 * the reason is not that they are the same event — they are deliberately
 * distinguished at the classifier, because *this panel gave up on GitLab* and
 * *you navigated away* are different answers. What they share is the only
 * property this predicate asks about: the request was dispatched and its answer
 * never arrived. A deadline that elapses while a `PUT /merge` is in flight says
 * nothing about whether GitLab merged, so classifying it as a refusal made
 * before dispatch would report "nothing was attempted" about a merge that may
 * be in production.
 */
const ANSWER_LOST_FAILURE_CODES: ReadonlySet<string> = new Set([
  'transport-failed',
  'cancelled',
  'deadline-exceeded',
  'undecodable-body',
]);

/**
 * Whether a failed write may nonetheless have taken effect.
 *
 * `sources/SCM.md` §4.7.2's rule is that a status code is not evidence of an
 * effect; its dual is that a *missing* answer is not evidence of no effect. A
 * write whose answer was lost is settled by the one confirming read every
 * mutation already performs — never by a second write, and never by reporting
 * that nothing was attempted.
 */
export function gitlabWriteAnswerLost(
  result: Extract<GitlabRequestResult, Readonly<{ kind: 'failed' }>>,
): boolean {
  return result.status === undefined && ANSWER_LOST_FAILURE_CODES.has(result.failure.code);
}

/**
 * The one confirming read shared by every Action.
 *
 * Every mutation's terminal claim comes from here and never from the write's own
 * response: GitLab's merge call answers `200` on a merge it only *scheduled*,
 * and a status code that means "accepted" is not evidence of an effect.
 *
 * It takes the successful preflight itself, so the route it reads is provably
 * the route the write addressed. A confirming read built from anything else
 * could confirm a different item.
 */
export async function confirmGitlabItemMutation<TRow extends GitlabIdentifiedRow>(
  input: Readonly<{
    route: GitlabDetailRouteInputV1;
    dependencies: GitlabDetailReadDependenciesV1;
    subject: GitlabMutationSubjectV1<TRow>;
  }>,
): Promise<
  | Readonly<{ ok: true; row: TRow }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
> {
  const read = await requestGitlabJson({
    invocation: input.dependencies.invocation,
    url: buildGitlabItemUrl(input.route),
    fetcher: input.dependencies.fetcher,
    signal: input.dependencies.signal,
    nowMs: input.dependencies.nowMs,
  });
  if (read.kind === 'failed') {
    return Object.freeze({
      ok: false as const,
      failure: projectGitlabSourceFailure(read.failure),
    });
  }
  const decoded = input.subject.decode(read.response.body);
  return decoded.ok
    ? Object.freeze({ ok: true as const, row: decoded.row })
    : Object.freeze({ ok: false as const, failure: UNDECODABLE_ITEM_FAILURE });
}
