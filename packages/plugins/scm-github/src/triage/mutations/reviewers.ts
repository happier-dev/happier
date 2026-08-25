import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';

import {
  decodeGithubJsonResponse,
  type GithubApiClientV1,
  type GithubApiResponseV1,
} from '../../observations/githubApiClient.js';

import {
  classifyGithubResponseFailure,
  classifyGithubTransportFailure,
  isGithubSuccessStatus,
} from '../errors.js';
import { readGithubPullRequest } from '../get.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import {
  createGithubRepositoryReader,
  type GithubRepositoryReaderV1,
} from '../repositories.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type { GithubRequestedReviewersV1 } from './contracts.js';
import type { GithubMutationDependenciesV1 } from './pullRequest.js';

/**
 * Adding and withdrawing review requests for named people and teams.
 *
 * BOTH directions are EXACT DELTAS and never a desired full set. GitHub publishes
 * `POST .../requested_reviewers` for additions and a `DELETE` on the same
 * collection for withdrawals; expressing "who should be reviewing" as one
 * replacement list would silently withdraw a reviewer a colleague requested
 * between our read and our write. The Action the user invoked said "also ask
 * these people" or "stop asking these people", and that is exactly what leaves.
 *
 * The two directions share this module because they share every hard part: the
 * identity read, the single reviewer-collection reader, the preflight decision
 * and the confirmation that checks only the NAMED members. Two copies of that
 * would be two answers to "who is requested now", and they would drift.
 *
 * The addition is AT-MOST-ONCE rather than idempotent, and the preflight read is
 * what makes that true. Re-requesting someone who is already pending is not a
 * no-op on GitHub — it re-notifies them, and for a reviewer who already reviewed
 * it asks them to review again. So a request whose every named addition is
 * already pending is answered from the read with no request at all. The
 * withdrawal is idempotent, and its preflight spares a write with no effect to
 * confirm rather than preventing a notification.
 *
 * Identity is validated by the SAME canonical pull-request read every other write
 * uses. A routing token is the newest locator this source holds and it can be
 * stale; `owner/repo#1284` resolving to a different repository's pull request
 * would otherwise summon strangers to someone else's code — or withdraw them
 * from it.
 */

export type GithubReviewerDeltaOutcomeV1 =
  | Readonly<{
    kind: 'applied';
    effect: 'changed' | 'alreadySatisfied';
    requestedReviewers: GithubRequestedReviewersV1;
  }>
  | Readonly<{
    kind: 'uncertain';
    requestedReviewers?: GithubRequestedReviewersV1;
    failure?: TriageSourceFailureV1;
  }>
  | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

const ENTRY_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_entry_not_observed',
});

const REVIEWERS_BODY_INVALID_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'github_requested_reviewers_invalid',
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one string member off each element of a GitHub actor collection. */
function readNames(value: unknown, member: string): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const name = entry[member];
    return typeof name === 'string' && name.trim() ? [name.trim()] : [];
  }));
}

type ReviewersRead =
  | Readonly<{ ok: true; reviewers: GithubRequestedReviewersV1 }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

/**
 * The one read of the reviewer collection, used for BOTH the preflight decision
 * and the confirmation. Two readers of "who is currently requested" would be two
 * answers to the question this write's at-most-once guarantee rests on.
 */
async function readRequestedReviewers(
  url: string,
  dependencies: Readonly<{ client: GithubApiClientV1; now: () => number }>,
): Promise<ReviewersRead> {
  let response: GithubApiResponseV1;
  try {
    response = await dependencies.client.request({ url });
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
    });
  }
  let body: unknown;
  try {
    body = decodeGithubJsonResponse(response);
  } catch (error) {
    return Object.freeze({
      ok: false as const,
      failure: toTriageFailure(classifyGithubTransportFailure(error)),
    });
  }
  if (!isRecord(body)) {
    return Object.freeze({ ok: false as const, failure: REVIEWERS_BODY_INVALID_FAILURE });
  }
  return Object.freeze({
    ok: true as const,
    reviewers: Object.freeze({
      users: readNames(body.users, 'login'),
      teams: readNames(body.teams, 'slug'),
    }),
  });
}

/**
 * Confirmation checks ONLY the named members, in whichever direction was asked.
 * It never requires the observed set to equal anything, because a colleague
 * adding or withdrawing an unrelated reviewer between our write and our read is
 * not a failure of this Action.
 *
 * GitHub logins and team slugs are case-insensitive and it answers in its own
 * canonical casing, so a user who typed `OctoCat` must not be reported as an
 * unconfirmed change in either direction.
 */
function everyNameIsPresent(
  observed: readonly string[],
  named: readonly string[],
  expected: boolean,
): boolean {
  const present = new Set(observed.map((name) => name.toLowerCase()));
  return named.every((name) => present.has(name.toLowerCase()) === expected);
}

function satisfies(
  observed: GithubRequestedReviewersV1,
  named: Readonly<{ users: readonly string[]; teams: readonly string[] }>,
  /** `true` once every named reviewer is requested; `false` once none of them is. */
  expected: boolean,
): boolean {
  return everyNameIsPresent(observed.users, named.users, expected)
    && everyNameIsPresent(observed.teams, named.teams, expected);
}

/**
 * The one implementation both reviewer Actions run. The direction decides three
 * things and nothing else: the HTTP verb GitHub publishes for it, and what
 * "already satisfied" and "confirmed" mean about the named members.
 */
async function applyGithubPullRequestReviewerDelta(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    users: readonly string[];
    teams: readonly string[];
  }>,
  direction: Readonly<{ method: 'POST' | 'DELETE'; requestedAfterwards: boolean }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubReviewerDeltaOutcomeV1> {
  const repositories: GithubRepositoryReaderV1 = dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });

  // Identity first: the canonical read is what proves this route still holds THIS
  // entry. Cached corpus bytes explain what the user selected; they never
  // authorize the write.
  const entry = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  if (entry.observation.kind === 'unresolved') {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(entry.observation.failure),
    });
  }
  if (entry.observation.kind !== 'present') {
    return Object.freeze({ kind: 'failed' as const, failure: ENTRY_UNAVAILABLE_FAILURE });
  }

  const url = buildGithubApiUrl([
    'repos',
    input.route.owner,
    input.route.name,
    'pulls',
    input.localRef.entryId,
    'requested_reviewers',
  ]);

  const current = await readRequestedReviewers(url, dependencies);
  if (!current.ok) return Object.freeze({ kind: 'failed' as const, failure: current.failure });
  if (satisfies(current.reviewers, input, direction.requestedAfterwards)) {
    return Object.freeze({
      kind: 'applied' as const,
      effect: 'alreadySatisfied' as const,
      requestedReviewers: current.reviewers,
    });
  }

  const dispatch = async (): Promise<
    | Readonly<{ ok: true; response: GithubApiResponseV1 }>
    | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>
  > => {
    try {
      return Object.freeze({
        ok: true as const,
        response: await dependencies.client.request({
          url,
          method: direction.method,
          headers: { 'content-type': 'application/json' },
          // Only the named members. An empty member is omitted rather than sent as
          // an empty array, which GitHub reads as a well-formed request for nobody.
          body: new TextEncoder().encode(JSON.stringify({
            ...(input.users.length === 0 ? {} : { reviewers: [...input.users] }),
            ...(input.teams.length === 0 ? {} : { team_reviewers: [...input.teams] }),
          })),
        }),
      });
    } catch (error) {
      return Object.freeze({
        ok: false as const,
        failure: toTriageFailure(classifyGithubTransportFailure(error)),
      });
    }
  };

  let response: GithubApiResponseV1;
  // Requesting review is at-most-once because a second POST re-notifies people.
  // Withdrawal is naturally idempotent and retains its ordinary response path.
  if (direction.requestedAfterwards) {
    const settlement = await settleAtMostOnceProviderWrite({
      dispatch,
      mayHaveChanged: (result) => !result.ok,
      confirm: async () => {
        const confirmed = await readRequestedReviewers(url, dependencies);
        if (!confirmed.ok) {
          return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
        }
        return satisfies(confirmed.reviewers, input, true)
          ? Object.freeze({ kind: 'applied' as const, observation: confirmed.reviewers })
          : Object.freeze({ kind: 'unchanged' as const, observation: confirmed.reviewers });
      },
    });
    if (settlement.kind === 'applied') {
      return Object.freeze({
        kind: 'applied' as const,
        effect: 'changed' as const,
        requestedReviewers: settlement.observation,
      });
    }
    if (settlement.kind === 'unchanged') {
      return Object.freeze({
        kind: 'uncertain' as const,
        requestedReviewers: settlement.observation,
      });
    }
    if (settlement.kind === 'uncertain') {
      return Object.freeze({
        kind: 'uncertain' as const,
        ...(settlement.observation === undefined
          ? {}
          : { requestedReviewers: settlement.observation }),
        ...(settlement.failure === undefined ? {} : { failure: settlement.failure }),
      });
    }
    if (!settlement.result.ok) {
      // Unreachable by the at-most-once classifier above, but keeping the
      // exhaustive arm makes a future classifier change fail safely.
      return Object.freeze({ kind: 'failed' as const, failure: settlement.result.failure });
    }
    response = settlement.result.response;
  } else {
    const written = await dispatch();
    if (!written.ok) {
      return Object.freeze({ kind: 'failed' as const, failure: written.failure });
    }
    response = written.response;
  }
  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
    });
  }

  // The write's own response body is not the claim: the confirming read is.
  const confirmed = await readRequestedReviewers(url, dependencies);
  if (!confirmed.ok) {
    return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
  }
  return satisfies(confirmed.reviewers, input, direction.requestedAfterwards)
    ? Object.freeze({
      kind: 'applied' as const,
      effect: 'changed' as const,
      requestedReviewers: confirmed.reviewers,
    })
    // Accepted, and the change was not observed. It is never reported as success
    // and never automatically retried: a retried addition would re-notify, and a
    // retried withdrawal would re-decide against state the user never saw.
    : Object.freeze({ kind: 'uncertain' as const, requestedReviewers: confirmed.reviewers });
}

/** Requests review from exactly the named users and teams. */
export async function requestGithubPullRequestReviewers(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    users: readonly string[];
    teams: readonly string[];
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubReviewerDeltaOutcomeV1> {
  return applyGithubPullRequestReviewerDelta(
    input,
    { method: 'POST', requestedAfterwards: true },
    dependencies,
  );
}

/**
 * Withdraws the review request from exactly the named users and teams.
 *
 * GitHub's own withdrawal is a `DELETE` on the same collection carrying the same
 * delta body. `PUT`ting a desired set would be the replacement authority the user
 * never granted, and it is not used here for the same reason it is not used for
 * the addition.
 */
export async function removeGithubPullRequestReviewers(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    users: readonly string[];
    teams: readonly string[];
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubReviewerDeltaOutcomeV1> {
  return applyGithubPullRequestReviewerDelta(
    input,
    { method: 'DELETE', requestedAfterwards: false },
    dependencies,
  );
}
