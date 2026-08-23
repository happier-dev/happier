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
import { readGithubIssue, type GithubIssueFactsV1, type GithubIssueReadV1 } from '../get.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure, toTriageObservation } from '../mapping/protocol.js';
import {
  createGithubRepositoryReader,
  type GithubRepositoryReaderV1,
} from '../repositories.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type { GithubIssueCloseReasonV1 } from './contracts.js';
import type { GithubMutationDependenciesV1 } from './pullRequest.js';

/**
 * The GitHub issue writes: the two state transitions and the four exact deltas.
 *
 * They run the same three beats every pull-request write runs, and nothing
 * between them is shared state: reauthorize and REREAD the provider entity,
 * decide, then write and confirm. Cached corpus bytes never authorize a write, so
 * the preflight read is not an optimization to skip — it is the write's
 * precondition, and its observation is what an already-satisfied answer hands back
 * so the host re-renders what is true now.
 *
 * NO issue write carries a head pin, and that omission is deliberate (SCM.md 2.6):
 * an issue has no head, so pinning one would add a failure mode protecting no
 * invariant.
 *
 * Every delta is provider-native. `PATCH /issues/{n}` with `assignees` or
 * `labels`, `PUT .../labels` and `DELETE .../labels` are forbidden here because
 * all three express replacement or remove-all authority the user did not grant:
 * they would silently drop the assignee or label a colleague added between our
 * read and our write. GitHub's own add/remove endpoints cannot.
 */

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
type Refused = Readonly<{
  kind: 'refused';
  reason: 'state_changed';
  observation?: ProjectedObservation;
}>;
type Uncertain = Readonly<{
  kind: 'uncertain';
  observation?: ProjectedObservation;
  failure?: TriageSourceFailureV1;
}>;
type Failed = Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

export type GithubIssueStateOutcomeV1 = Applied | Refused | Uncertain | Failed;

/** A delta has no refusal vocabulary: there is no state this source decides for GitHub. */
export type GithubIssueDeltaOutcomeV1 = Applied | Uncertain | Failed;

/**
 * One settled provider read, reduced to what a write decision needs: the projected
 * observation the caller hands back, and the typed facts the precondition compares.
 */
type Current =
  | Readonly<{ ok: true; facts: GithubIssueFactsV1; observation: ProjectedObservation }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

function reduce(read: GithubIssueReadV1): Current {
  if (read.observation.kind === 'present' && read.facts !== null) {
    return Object.freeze({
      ok: true as const,
      facts: read.facts,
      observation: toTriageObservation(read.observation),
    });
  }
  if (read.observation.kind === 'unresolved') {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(read.observation.failure),
    });
  }
  // An absent or transferred entry is not a state this write can converge on, and
  // saying so is different from reporting a provider error. A transfer renumbers
  // the issue, so writing to the route the user held would address a stranger.
  return Object.freeze({
    ok: false as const,
    failure: read.observation.kind === 'absent'
      ? ENTRY_ABSENT_FAILURE
      : ENTRY_NOT_OBSERVED_FAILURE,
  });
}

function issueUrl(
  route: GithubRepositoryRouteV1,
  entryNumber: string,
  ...tail: readonly string[]
): string {
  return buildGithubApiUrl(['repos', route.owner, route.name, 'issues', entryNumber, ...tail]);
}

function openResolver(dependencies: GithubMutationDependenciesV1): GithubRepositoryReaderV1 {
  return dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
}

/** One write request, with its JSON body encoded here and nowhere else. */
async function send(
  dependencies: GithubMutationDependenciesV1,
  request: Readonly<{
    url: string;
    method: GithubApiMethodV1;
    body?: Readonly<Record<string, unknown>>;
  }>,
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
        ...(request.body === undefined ? {} : {
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(request.body)),
        }),
      }),
    });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
}

/** The single confirming read every issue write runs, under the same signal. */
async function confirm(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubMutationDependenciesV1,
): Promise<Current> {
  return reduce(await readGithubIssue(localRef, route, repositories, dependencies));
}

/**
 * Turns a settled write plus its confirming read into the one outcome that is
 * true. A confirming read that cannot yet observe the requested state reports
 * `uncertain`; it never claims the write happened, and it never reissues it.
 */
function settle(
  confirmed: Current,
  satisfied: (facts: GithubIssueFactsV1) => boolean,
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

/* --------------------------------------------------------------- close/reopen */

/**
 * The issue state transition GitHub publishes: `PATCH /issues/{n}` with `state`
 * and, when closing, the caller's explicit `state_reason`.
 *
 * The reason is carried, never chosen. GitHub shows "closed as completed" and
 * "closed as not planned" differently to everyone watching the issue, so defaulting
 * it would publish a claim the person did not make.
 */
async function transitionGithubIssueState(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  transition: Readonly<{ target: 'closed' | 'open'; stateReason?: GithubIssueCloseReasonV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueStateOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubIssue(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  // Converging on the state GitHub already holds is answered from the read with no
  // request at all. A second close does not create a second closure.
  if (current.facts.state === transition.target) return alreadySatisfied(current);
  const expected = transition.target === 'closed' ? 'open' : 'closed';
  if (current.facts.state !== expected) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }

  const written = await send(dependencies, {
    url: issueUrl(input.route, input.localRef.entryId),
    method: 'PATCH',
    body: {
      state: transition.target,
      ...(transition.stateReason === undefined ? {} : { state_reason: transition.stateReason }),
    },
  });
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });
  if (!isGithubSuccessStatus(written.response.status)) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(
        classifyGithubResponseFailure(written.response, dependencies.now()),
      ),
    });
  }

  // The PATCH response body is not the claim: the confirming read is.
  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    (facts) => facts.state === transition.target,
  );
}

export async function closeGithubIssue(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    stateReason: GithubIssueCloseReasonV1;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueStateOutcomeV1> {
  return transitionGithubIssueState(
    input,
    { target: 'closed', stateReason: input.stateReason },
    dependencies,
  );
}

/**
 * Reopening sends `state` alone. GitHub owns `state_reason: 'reopened'` itself,
 * and there is no other reason a person could mean.
 */
export async function reopenGithubIssue(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueStateOutcomeV1> {
  return transitionGithubIssueState(input, { target: 'open' }, dependencies);
}

/* ---------------------------------------------------------------- membership */

/**
 * Assignee and label names are compared case-insensitively.
 *
 * GitHub logins are case-insensitive and it answers in its own canonical casing,
 * and a repository cannot hold two labels differing only in case. Comparing
 * exactly would report a person who typed `Bug` as an unconfirmed change to a
 * label GitHub just added.
 */
function everyNameIsPresent(
  observed: readonly string[],
  named: readonly string[],
  expected: boolean,
): boolean {
  const present = new Set(observed.map((name) => name.toLowerCase()));
  return named.every((name) => present.has(name.toLowerCase()) === expected);
}

/**
 * The one implementation all four issue deltas run.
 *
 * The direction decides three things and nothing else: which native endpoint and
 * verb GitHub publishes for it, and what "already satisfied" and "confirmed" mean
 * about the NAMED members. Everything hard — the identity read, the preflight, the
 * confirming read, and the refusal to claim an unobserved effect — has one owner.
 */
async function applyGithubIssueMembershipDelta(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    /** Exactly the members the caller named. Never a desired full set. */
    named: readonly string[];
  }>,
  delta: Readonly<{
    /** Reads the member list this delta is about off the confirming read's facts. */
    observe: (facts: GithubIssueFactsV1) => readonly string[];
    /** GitHub's own endpoint for this exact delta, relative to the issue. */
    request: (localRef: GithubTriageEntryLocalRefV1, route: GithubRepositoryRouteV1) => Readonly<{
      url: string;
      method: GithubApiMethodV1;
      body?: Readonly<Record<string, unknown>>;
    }>;
    /** `true` once every named member is present; `false` once none of them is. */
    presentAfterwards: boolean;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueDeltaOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubIssue(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });

  if (everyNameIsPresent(
    delta.observe(current.facts),
    input.named,
    delta.presentAfterwards,
  )) {
    return alreadySatisfied(current);
  }

  const written = await send(dependencies, delta.request(input.localRef, input.route));
  if (!written.ok) return Object.freeze({ kind: 'failed' as const, failure: written.failure });
  if (!isGithubSuccessStatus(written.response.status)) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(
        classifyGithubResponseFailure(written.response, dependencies.now()),
      ),
    });
  }

  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    (facts) => everyNameIsPresent(delta.observe(facts), input.named, delta.presentAfterwards),
  );
}

type IssueMembershipInputV1 = Readonly<{
  localRef: GithubTriageEntryLocalRefV1;
  route: GithubRepositoryRouteV1;
}>;

const readAssignees = (facts: GithubIssueFactsV1): readonly string[] => facts.assignees;
const readLabels = (facts: GithubIssueFactsV1): readonly string[] => facts.labels;

export async function addGithubIssueAssignees(
  input: IssueMembershipInputV1 & Readonly<{ usernames: readonly string[] }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueDeltaOutcomeV1> {
  return applyGithubIssueMembershipDelta({ ...input, named: input.usernames }, {
    observe: readAssignees,
    presentAfterwards: true,
    request: (localRef, route) => ({
      url: issueUrl(route, localRef.entryId, 'assignees'),
      method: 'POST',
      body: { assignees: [...input.usernames] },
    }),
  }, dependencies);
}

export async function removeGithubIssueAssignees(
  input: IssueMembershipInputV1 & Readonly<{ usernames: readonly string[] }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueDeltaOutcomeV1> {
  return applyGithubIssueMembershipDelta({ ...input, named: input.usernames }, {
    observe: readAssignees,
    presentAfterwards: false,
    request: (localRef, route) => ({
      url: issueUrl(route, localRef.entryId, 'assignees'),
      method: 'DELETE',
      body: { assignees: [...input.usernames] },
    }),
  }, dependencies);
}

export async function addGithubIssueLabels(
  input: IssueMembershipInputV1 & Readonly<{ labels: readonly string[] }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueDeltaOutcomeV1> {
  return applyGithubIssueMembershipDelta({ ...input, named: input.labels }, {
    observe: readLabels,
    presentAfterwards: true,
    request: (localRef, route) => ({
      url: issueUrl(route, localRef.entryId, 'labels'),
      method: 'POST',
      body: { labels: [...input.labels] },
    }),
  }, dependencies);
}

/**
 * Removes exactly ONE label, because that is the only single-label delete GitHub
 * publishes. The name travels as one encoded path segment, so a label carrying a
 * slash or a space addresses itself rather than a route the source invented.
 */
export async function removeGithubIssueLabel(
  input: IssueMembershipInputV1 & Readonly<{ label: string }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubIssueDeltaOutcomeV1> {
  return applyGithubIssueMembershipDelta({ ...input, named: [input.label] }, {
    observe: readLabels,
    presentAfterwards: false,
    request: (localRef, route) => ({
      url: issueUrl(route, localRef.entryId, 'labels', input.label),
      method: 'DELETE',
    }),
  }, dependencies);
}
