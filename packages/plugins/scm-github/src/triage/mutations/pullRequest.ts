import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type {
  GithubApiMethodV1,
  GithubApiResponseV1,
} from '../../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from '../errors.js';
import {
  readGithubPullRequest,
  type GithubGetDependenciesV1,
  type GithubPullRequestFactsV1,
  type GithubPullRequestReadV1,
} from '../get.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure, toTriageObservation } from '../mapping/protocol.js';
import {
  createGithubRepositoryReader,
  type GithubRepositoryReaderV1,
} from '../repositories.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type { GithubMergeMethodV1 } from './contracts.js';
import { sendGithubGraphqlRequest } from './graphql.js';

/**
 * The head-pinned and state-transition GitHub pull-request writes, each
 * expressed end to end.
 *
 * Every one of them runs the same three beats and nothing between them is
 * shared state: reauthorize and REREAD the provider entity, decide, then write
 * and confirm. Cached corpus bytes never authorize a write, so the preflight
 * read is not an optimization to skip — it is the write's precondition, and its
 * observation is what a refusal hands back so the host re-renders what is true
 * now rather than prompting a blind retry.
 *
 * The head pin is carried only by `merge`, and it is compared, never filled. The
 * three forbidden softenings are the whole reason this module reads before it
 * writes: filling the pin from a fresh read reintroduces the exact race, an
 * automatic retry after the head moved re-decides on the user's behalf, and a
 * generic error leaves the host rendering a head GitHub no longer has.
 */

/**
 * Every write in this vertical READS before it writes and reads again to confirm,
 * so a write's dependencies are exactly a read's. They are the read owner's type
 * rather than a structurally identical copy: two names for one set of collaborators
 * is how one of them quietly grows a member the other does not honour.
 */
export type GithubMutationDependenciesV1 = GithubGetDependenciesV1;

const ENTRY_ABSENT_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_entry_absent',
});

const ENTRY_NOT_OBSERVED_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_entry_not_observed',
});

type ProjectedObservation = ReturnType<typeof toTriageObservation>;

type Applied = Readonly<{
  kind: 'applied';
  effect: 'changed' | 'alreadySatisfied';
  observation: ProjectedObservation;
}>;
type Refused<TReason extends string> = Readonly<{
  kind: 'refused';
  reason: TReason;
  observation?: ProjectedObservation;
}>;
type Uncertain = Readonly<{
  kind: 'uncertain';
  observation?: ProjectedObservation;
  failure?: TriageSourceFailureV1;
}>;
type Failed = Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

export type GithubMergeRefusalReasonV1 =
  | 'head_advanced'
  | 'state_changed'
  | 'not_mergeable'
  | 'merge_method_not_allowed';

export type GithubPullRequestMergeOutcomeV1 =
  | Applied
  | Refused<GithubMergeRefusalReasonV1>
  | Uncertain
  | Failed;

export type GithubPullRequestStateOutcomeV1 =
  | Applied
  | Refused<'state_changed'>
  | Uncertain
  | Failed;

/** Both head-pinned transitions refuse for the same two reasons. */
export type GithubPinnedTransitionRefusalReasonV1 = 'head_advanced' | 'state_changed';

export type GithubPullRequestMarkReadyOutcomeV1 =
  | Applied
  | Refused<GithubPinnedTransitionRefusalReasonV1>
  | Uncertain
  | Failed;

/**
 * `pending` is a settled outcome of its own: GitHub accepted the request and the
 * confirming read has not yet observed the branch move. It is neither a success
 * claim nor an unknown.
 */
type AcceptedPending = Readonly<{ kind: 'pending'; observation: ProjectedObservation }>;

export type GithubPullRequestUpdateBranchOutcomeV1 =
  | Applied
  | AcceptedPending
  | Refused<GithubPinnedTransitionRefusalReasonV1>
  | Uncertain
  | Failed;

/**
 * One settled provider read, reduced to what a write decision needs: the
 * projected observation the caller hands back, and the typed facts the
 * precondition compares.
 */
type Current =
  | Readonly<{
    ok: true;
    facts: GithubPullRequestFactsV1;
    observation: ProjectedObservation;
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

function reduce(read: GithubPullRequestReadV1): Current {
  if (read.observation.kind === 'present' && read.facts !== null) {
    return Object.freeze({
      ok: true as const,
      facts: read.facts,
      observation: toTriageObservation(read.observation),
    });
  }
  if (read.observation.kind === 'unresolved') {
    return Object.freeze({ ok: false as const, failure: toTriageFailure(read.observation.failure) });
  }
  // An absent or renumbered entry is not a state this transition can converge on,
  // and saying so is different from reporting a provider error.
  return Object.freeze({
    ok: false as const,
    failure: read.observation.kind === 'absent' ? ENTRY_ABSENT_FAILURE : ENTRY_NOT_OBSERVED_FAILURE,
  });
}

function pullRequestUrl(route: GithubRepositoryRouteV1, entryNumber: string): string {
  return buildGithubApiUrl(['repos', route.owner, route.name, 'pulls', entryNumber]);
}

/** One write request, with its JSON body encoded here and nowhere else. */
async function send(
  dependencies: GithubMutationDependenciesV1,
  request: Readonly<{ url: string; method: GithubApiMethodV1; body: Readonly<Record<string, unknown>> }>,
): Promise<
  | Readonly<{ ok: true; response: GithubApiResponseV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
> {
  try {
    return Object.freeze({
      ok: true as const,
      response: await dependencies.client.request({
        url: request.url,
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(request.body)),
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
}

/**
 * The single confirming read every outcome that may have changed provider state
 * runs, under the same signal and the same source-owned private Action deadline
 * as the write.
 */
async function confirm(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubMutationDependenciesV1,
): Promise<Current> {
  return reduce(await readGithubPullRequest(localRef, route, repositories, dependencies));
}

/**
 * Turns a settled write plus its confirming read into the one outcome that is
 * true. A confirming read that cannot yet observe the requested terminal state
 * reports `uncertain`; it never claims the transition happened, and it never
 * issues a second write.
 */
function settle(
  confirmed: Current,
  satisfied: (facts: GithubPullRequestFactsV1) => boolean,
): Applied | Uncertain {
  if (!confirmed.ok) {
    return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
  }
  return satisfied(confirmed.facts)
    ? Object.freeze({
      kind: 'applied' as const,
      effect: 'changed' as const,
      observation: confirmed.observation,
    })
    : Object.freeze({ kind: 'uncertain' as const, observation: confirmed.observation });
}

function alreadySatisfied(current: Current & Readonly<{ ok: true }>): Applied {
  return Object.freeze({
    kind: 'applied' as const,
    effect: 'alreadySatisfied' as const,
    observation: current.observation,
  });
}

function openResolver(dependencies: GithubMutationDependenciesV1): GithubRepositoryReaderV1 {
  return dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
}

/* ---------------------------------------------------------------------- merge */

/**
 * GitHub's merge owns ONE external effect: the merge.
 *
 * Its documented body carries `commit_title`, `commit_message`, `sha` and
 * `merge_method`, and it has no atomic branch-deletion parameter — so a
 * successful merge is never followed by a source-ref delete. That endpoint has no
 * expected-tip guard, and a read-before-delete cannot close the window in which a
 * collaborator pushes and Happier deletes their later work. Whether the branch
 * disappears is the repository's own automatic-deletion setting.
 */
export async function mergeGithubPullRequest(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    /** The head the user acted on. Compared, never filled. */
    headRevision: string;
    mergeMethod: GithubMergeMethodV1;
    commitTitle?: string;
    commitMessage?: string;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestMergeOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  // Merging a merged pull request converges on the same state, so it is answered
  // from the read with no request at all.
  if (current.facts.merged) return alreadySatisfied(current);
  if (current.facts.state !== 'open') {
    return Object.freeze({ kind: 'refused' as const, reason: 'state_changed' as const, observation: current.observation });
  }
  if (current.facts.headRevision !== input.headRevision) {
    return Object.freeze({ kind: 'refused' as const, reason: 'head_advanced' as const, observation: current.observation });
  }

  // Three levels must agree before a merge is attempted: the forge can do it, the
  // repository's settings permit this method, and the viewer may ask. Only the
  // middle one is knowable here without a second guess, and it refuses ONLY on an
  // explicit `false` — GitHub omits `allow_*` for some credentials, and reading
  // silence as a prohibition would refuse a merge the repository allows.
  const repository = await repositories.read(input.route);
  if (repository.kind === 'readable' && repository.mergeSettings[input.mergeMethod] === false) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'merge_method_not_allowed' as const,
      observation: current.observation,
    });
  }

  const written = await send(dependencies, {
    url: `${pullRequestUrl(input.route, input.localRef.entryId)}/merge`,
    method: 'PUT',
    body: {
      // GitHub's own precondition, carrying the user's pinned head verbatim.
      sha: input.headRevision,
      merge_method: input.mergeMethod,
      ...(input.commitTitle === undefined ? {} : { commit_title: input.commitTitle }),
      ...(input.commitMessage === undefined ? {} : { commit_message: input.commitMessage }),
    },
  });
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });

  const response = written.response;
  if (isGithubSuccessStatus(response.status)) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      (facts) => facts.merged,
    );
  }
  // `405` is "GitHub will not merge this now" and `409` is "the head moved under
  // the precondition". Both perform only the same confirming read, and neither
  // blindly retries the write.
  if (response.status === 405 || response.status === 409) {
    const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
    const reason: GithubMergeRefusalReasonV1 = response.status === 409
      ? 'head_advanced'
      : 'not_mergeable';
    return Object.freeze({
      kind: 'refused' as const,
      reason,
      ...(confirmed.ok ? { observation: confirmed.observation } : {}),
    });
  }
  return Object.freeze({
    kind: 'failed' as const,
    failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
  });
}

/* ----------------------------------------------------------------- mark ready */

/**
 * GitHub's native draft → ready transition, and the only one it publishes.
 *
 * `PATCH /pulls/{n}` documents `title`, `body`, `state`, `base` and
 * `maintainer_can_modify`; it has no draft field, and a REST body field GitHub
 * does not document is silently ignored. Silently doing nothing is the worst
 * outcome here, because the user believes their pull request is now ready and
 * every named reviewer was summoned. So this uses the transition GitHub
 * actually exposes.
 */
const MARK_READY_MUTATION = 'mutation MarkReady($pullRequestId: ID!) {'
  + ' markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId })'
  + ' { pullRequest { id isDraft } } }';

/** The confirming read observed the entity, but it carried no GraphQL node id. */
const ENTITY_ID_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_entity_id_unavailable',
});

/**
 * Marks one draft pull request ready for review, at the exact head the user saw.
 *
 * Draft → ready is the write whose EFFECT IS THE NOTIFICATION: it triggers CI and
 * summons every named reviewer to review a specific commit set. Against a stale
 * head those humans are summoned to code the acting user never saw, which is why
 * this transition pins the head even though GitHub offers no precondition for it.
 * Where the forge accepts no precondition the pattern is read, compare, refuse
 * before writing — and the refusal carries the head GitHub currently has, so the
 * surface re-renders what is true now instead of prompting a blind retry.
 */
export async function markGithubPullRequestReady(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    /** The head the user acted on. Compared, never filled. */
    headRevision: string;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestMarkReadyOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  // A pull request that is no longer a draft has converged on the requested
  // state, and it is answered from the read with no request at all. This is what
  // keeps a second invocation from re-notifying every reviewer.
  if (!current.facts.draft) return alreadySatisfied(current);
  if (current.facts.state !== 'open') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }
  if (current.facts.headRevision !== input.headRevision) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'head_advanced' as const,
      observation: current.observation,
    });
  }
  // The GraphQL transition addresses the entity by the node id THIS validated read
  // published. Without it there is no entity to address, and guessing one from the
  // number would address whatever currently occupies that route.
  if (current.facts.nodeId === null) {
    return Object.freeze({ kind: 'failed' as const, failure: ENTITY_ID_UNAVAILABLE_FAILURE });
  }

  const written = await sendGithubGraphqlRequest(
    { query: MARK_READY_MUTATION, variables: { pullRequestId: current.facts.nodeId } },
    dependencies,
  );
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });

  // The GraphQL payload's own `isDraft` is NOT the claim. The confirming read is,
  // for the same reason every other write here rereads: the response describes the
  // request, and the entity describes the provider.
  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    (facts) => !facts.draft,
  );
}

/* -------------------------------------------------------------- update branch */

/**
 * Updates one pull request's branch from its base, at the exact head the user saw.
 *
 * This is the one write in this module where GitHub publishes a precondition of
 * its own for a non-merge transition: `expected_head_sha`. The pinned head is
 * therefore enforced TWICE — compared against the fresh read before dispatch, and
 * handed to GitHub verbatim — because our comparison alone leaves the window
 * between our read and GitHub's write open.
 *
 * `202 Accepted` means GitHub took the request. It does not mean the branch moved,
 * and this Action never claims it did: the confirming read decides, and a read
 * that still observes the pinned head settles as `pending`. There is no source
 * timer, no poll, and no second PUT.
 *
 * There is deliberately NO local "is it behind?" refusal. GitHub derives
 * mergeability asynchronously and publishes `mergeable_state: 'unknown'` while it
 * does, so a refusal read out of that field would block a legitimate update
 * whenever the answer had not been computed yet — the same mistake as reading an
 * unstated repository merge setting as a prohibition. GitHub's own `422` is the
 * authority on a branch that cannot be updated.
 */
export async function updateGithubPullRequestBranch(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    /** The head the user acted on. Compared AND sent as GitHub's precondition. */
    headRevision: string;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestUpdateBranchOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  if (current.facts.merged || current.facts.state !== 'open') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }
  if (current.facts.headRevision !== input.headRevision) {
    // Zero PUTs. The pin is never filled from this read: its whole value is that
    // it came from the read the USER acted on.
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'head_advanced' as const,
      observation: current.observation,
    });
  }

  const written = await send(dependencies, {
    url: `${pullRequestUrl(input.route, input.localRef.entryId)}/update-branch`,
    method: 'PUT',
    body: { expected_head_sha: input.headRevision },
  });
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });

  const response = written.response;
  if (isGithubSuccessStatus(response.status)) {
    const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
    if (!confirmed.ok) {
      return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
    }
    // The branch update lands as a NEW head commit. Observing the same head the
    // request was preconditioned on means the accepted update has not landed yet.
    return confirmed.facts.headRevision !== null
      && confirmed.facts.headRevision !== input.headRevision
      ? Object.freeze({
        kind: 'applied' as const,
        effect: 'changed' as const,
        observation: confirmed.observation,
      })
      : Object.freeze({ kind: 'pending' as const, observation: confirmed.observation });
  }
  if (response.status === 422) {
    // GitHub rejected the precondition or the update itself. Only the same
    // confirming read is performed, and the write is never reissued: a head that
    // moved is a refusal the user must re-decide, and anything else is the
    // classified provider failure.
    const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
    if (confirmed.ok && confirmed.facts.headRevision !== input.headRevision) {
      return Object.freeze({
        kind: 'refused' as const,
        reason: 'head_advanced' as const,
        observation: confirmed.observation,
      });
    }
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
    });
  }
  // `403` reaches the shared classifier, which reads GitHub's own
  // `x-accepted-github-permissions` header and settles it as `insufficient_scope`.
  return Object.freeze({
    kind: 'failed' as const,
    failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
  });
}

/* --------------------------------------------------------------- close/reopen */

type StateTransition = Readonly<{
  /** GitHub's own `state` value this transition writes. */
  target: 'closed' | 'open';
}>;

async function transitionGithubPullRequestState(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  transition: StateTransition,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestStateOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  if (current.facts.state === transition.target) return alreadySatisfied(current);
  // A merged pull request has no reopen: the transition GitHub offers is
  // closed → open, and a merge is terminal. Refusing names why; writing would
  // produce a provider error the user cannot act on.
  const blocked = transition.target === 'open'
    ? current.facts.merged || current.facts.state !== 'closed'
    : current.facts.state !== 'open';
  if (blocked) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }

  const written = await send(dependencies, {
    url: pullRequestUrl(input.route, input.localRef.entryId),
    method: 'PATCH',
    body: { state: transition.target },
  });
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });

  const response = written.response;
  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
    });
  }
  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    (facts) => facts.state === transition.target,
  );
}

export async function closeGithubPullRequest(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestStateOutcomeV1> {
  return transitionGithubPullRequestState(input, { target: 'closed' }, dependencies);
}

export async function reopenGithubPullRequest(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestStateOutcomeV1> {
  return transitionGithubPullRequestState(input, { target: 'open' }, dependencies);
}
