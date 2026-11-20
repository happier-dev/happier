import type { TriageSourceFailureV1, TriageTaskCreateFieldsV1, TriageTaskFieldsV1, TriageTaskWriteResultV1 } from '@happier-dev/triage-protocol/v1';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { decodeGithubJsonResponse } from '../../observations/githubApiClient.js';
import {
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
  type ReviewCommentClaimPublicationDispatchResponseV1,
  type ReviewCommentPublicationPlanV1,
} from '@happier-dev/plugin-sdk/reviews';

import type {
  GithubApiMethodV1,
} from '../../observations/githubApiClient.js';
import { sendGithubRestRequest as send } from './http.js';

import {
  classifyGithubResponseFailure,
  isGithubSuccessStatus,
  isGithubWriteResponseAmbiguous,
} from '../errors.js';
import { readGithubIssue, readGithubEntryMetadata, type GithubIssueFactsV1, type GithubIssueReadV1 } from '../get.js';
import { buildGithubApiUrl, type GithubRepositoryRouteV1 } from '../locator.js';
import { buildGithubEntryLocalRef, readGithubRepositoryIdFromCollisionScope } from '../identity.js';
import { decodeGithubIssueBody } from '../mapping/entry.js';
import { toTriageFailure, toTriageObservation } from '../mapping/protocol.js';
import {
  createGithubRepositoryReader,
  type GithubRepositoryReaderV1,
} from '../repositories.js';
import { readGithubIssueCommentPublicationRecords } from '../reviews.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';

import type { GithubIssueCloseReasonV1 } from './contracts.js';
import { preflightGithubPublicationCapability } from './publicationCapability.js';
import {
  recordGithubPublicationSettlement,
  type GithubPublicationSettlementV1,
} from './publicationSettlement.js';
import {
  type GithubMutationDependenciesV1,
  type GithubPullRequestReviewPublicationOutcomeV1,
} from './pullRequest.js';

/**
 * The GitHub issue writes: create, content edit, state transitions and exact deltas.
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

type ProjectedObservation = Extract<ReturnType<typeof toTriageObservation>, { kind: 'present' }>;

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

/** The single confirming read every issue write runs, under the same signal. */
async function confirm(
  localRef: GithubTriageEntryLocalRefV1,
  route: GithubRepositoryRouteV1,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubMutationDependenciesV1,
): Promise<Current> {
  return reduce(await readGithubEntryMetadata(localRef, route, repositories, dependencies));
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

export { reduce as reduceGithubEntryMutationRead, send as sendGithubEntryMutation };

/** Create identity comes only from the response; an answer-lost POST is never replayed. */
export async function createGithubIssue(
  input: Readonly<{ route: GithubRepositoryRouteV1; fields: TriageTaskCreateFieldsV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<TriageTaskWriteResultV1> {
  const repositories = openResolver(dependencies);
  const repository = await repositories.read(input.route);
  if (repository.kind !== 'readable') return { kind: 'failed', failure: toTriageFailure(repository.failure) };
  const settlement = await settleAtMostOnceProviderWrite<
    Awaited<ReturnType<typeof send>>, ProjectedObservation, TriageSourceFailureV1
  >({
    dispatch: () => send(dependencies, {
      url: buildGithubApiUrl(['repos', input.route.owner, input.route.name, 'issues']),
      method: 'POST',
      body: {
        title: input.fields.title,
        ...(input.fields.body === undefined ? {} : { body: input.fields.body }),
        ...(input.fields.assigneeIds === undefined ? {} : { assignees: input.fields.assigneeIds }),
        ...(input.fields.labelIds === undefined ? {} : { labels: input.fields.labelIds }),
      },
    }),
    mayHaveChanged: (result) => !result.ok || isGithubSuccessStatus(result.response.status)
      || isGithubWriteResponseAmbiguous(result.response),
    confirm: async (dispatched) => {
      // With no proven identity there is no safe confirming route to guess.
      if (!dispatched.ok) return { kind: 'uncertain' as const, failure: dispatched.failure };
      if (!isGithubSuccessStatus(dispatched.response.status)) {
        return { kind: 'uncertain' as const, failure: toTriageFailure(classifyGithubResponseFailure(dispatched.response, dependencies.now())) };
      }
      let body: unknown;
      try { body = decodeGithubJsonResponse(dispatched.response); } catch {
        return { kind: 'uncertain' as const };
      }
      const view = decodeGithubIssueBody(body, null);
      if (view === null || view.kindId !== 'issue'
        || view.owner.toLowerCase() !== input.route.owner.toLowerCase()
        || view.name.toLowerCase() !== input.route.name.toLowerCase()
        || (view.repositoryId !== null && view.repositoryId !== repository.repositoryId)) {
        return { kind: 'uncertain' as const };
      }
      const localRef = buildGithubEntryLocalRef({ kindId: 'issue', repositoryId: repository.repositoryId, nativeItemId: view.number });
      if (localRef === null) return { kind: 'uncertain' as const };
      const confirmed = await confirm(localRef, input.route, repositories, dependencies);
      if (!confirmed.ok) return { kind: 'uncertain' as const, failure: confirmed.failure };
      const matches = confirmed.facts.title === input.fields.title
        && (input.fields.body === undefined || confirmed.facts.body === input.fields.body)
        && everyNameIsPresent(confirmed.facts.assignees, input.fields.assigneeIds ?? [], true)
        && everyNameIsPresent(confirmed.facts.labels, input.fields.labelIds ?? [], true);
      return matches
        ? { kind: 'applied' as const, observation: confirmed.observation }
        : { kind: 'uncertain' as const, observation: confirmed.observation };
    },
  });
  if (settlement.kind === 'unchanged') return { kind: 'uncertain', observation: settlement.observation };
  return settlement.kind === 'settled'
    ? { kind: 'failed', failure: settlement.result.ok
      ? toTriageFailure(classifyGithubResponseFailure(settlement.result.response, dependencies.now()))
      : settlement.result.failure }
    : settlement;
}

/** Desired membership sets become exact native deltas against the initial fresh read. */
export async function editGithubIssue(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1; fields: TriageTaskFieldsV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<TriageTaskWriteResultV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(await readGithubIssue(input.localRef, input.route, repositories, dependencies));
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  const difference = (left: readonly string[], right: readonly string[]) => {
    const known = new Set(right.map((name) => name.toLowerCase()));
    return [...new Set(left)].filter((name) => !known.has(name.toLowerCase()));
  };
  const addedAssignees = input.fields.assigneeIds === undefined ? [] : difference(input.fields.assigneeIds, current.facts.assignees);
  const removedAssignees = input.fields.assigneeIds === undefined ? [] : difference(current.facts.assignees, input.fields.assigneeIds);
  const addedLabels = input.fields.labelIds === undefined ? [] : difference(input.fields.labelIds, current.facts.labels);
  const removedLabels = input.fields.labelIds === undefined ? [] : difference(current.facts.labels, input.fields.labelIds);
  const content = {
    ...(input.fields.title === undefined || input.fields.title === current.facts.title ? {} : { title: input.fields.title }),
    ...(input.fields.body === undefined || input.fields.body === current.facts.body ? {} : { body: input.fields.body }),
  };
  let changed = false;
  if (Object.keys(content).length > 0) {
    const settlement = await settleAtMostOnceProviderWrite({
      dispatch: () => send(dependencies, { url: issueUrl(input.route, input.localRef.entryId), method: 'PATCH', body: content }),
      mayHaveChanged: (result) => !result.ok || isGithubWriteResponseAmbiguous(result.response),
      confirm: async (dispatched) => {
        const observed = await confirm(input.localRef, input.route, repositories, dependencies);
        const failure = dispatched.ok
          ? toTriageFailure(classifyGithubResponseFailure(dispatched.response, dependencies.now()))
          : dispatched.failure;
        return { kind: 'uncertain' as const, ...(observed.ok ? { observation: observed.observation } : {}),
          failure };
      },
    });
    // An ambiguous content edit stops the compound write; reread evidence never
    // authorizes continuing the remaining fields or replaying the PATCH.
    if (settlement.kind !== 'settled') return { ...settlement, kind: 'uncertain' };
    const written = settlement.result;
    if (!written.ok) return { kind: 'failed', failure: written.failure };
    if (!isGithubSuccessStatus(written.response.status)) return { kind: 'failed', failure: toTriageFailure(classifyGithubResponseFailure(written.response, dependencies.now())) };
    changed = true;
  }
  const deltas: (() => Promise<GithubIssueDeltaOutcomeV1>)[] = [];
  const scopedDependencies = { ...dependencies, repositories };
  if (addedAssignees.length) deltas.push(() => addGithubIssueAssignees({ ...input, usernames: addedAssignees }, scopedDependencies));
  if (removedAssignees.length) deltas.push(() => removeGithubIssueAssignees({ ...input, usernames: removedAssignees }, scopedDependencies));
  if (addedLabels.length) deltas.push(() => addGithubIssueLabels({ ...input, labels: addedLabels }, scopedDependencies));
  for (const label of removedLabels) deltas.push(() => removeGithubIssueLabel({ ...input, label }, scopedDependencies));
  for (const delta of deltas) {
    const outcome = await delta();
    if (outcome.kind === 'applied') { changed ||= outcome.effect === 'changed'; continue; }
    if (outcome.kind === 'failed' && !changed) return outcome;
    const failure = outcome.failure;
    const observed = await confirm(input.localRef, input.route, repositories, dependencies);
    return { kind: 'uncertain', ...(observed.ok ? { observation: observed.observation } : {}), ...(failure === undefined ? {} : { failure }) };
  }
  const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
  if (!confirmed.ok) return { kind: 'uncertain', failure: confirmed.failure };
  const matches = (input.fields.title === undefined || input.fields.title === confirmed.facts.title)
    && (input.fields.body === undefined || input.fields.body === confirmed.facts.body)
    && everyNameIsPresent(confirmed.facts.assignees, input.fields.assigneeIds ?? [], true)
    && everyNameIsPresent(confirmed.facts.assignees, removedAssignees, false)
    && everyNameIsPresent(confirmed.facts.labels, input.fields.labelIds ?? [], true)
    && everyNameIsPresent(confirmed.facts.labels, removedLabels, false);
  return { kind: matches ? 'applied' : 'uncertain', observation: confirmed.observation };
}

/** Publishes one canonical Reviews proposal into one issue conversation. */
export async function publishGithubIssueComment(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    publicationPlan: ReviewCommentPublicationPlanV1;
    claimPublicationDispatch: () => Promise<ReviewCommentClaimPublicationDispatchResponseV1>;
    settlePublicationDispatch?: GithubPublicationSettlementV1;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestReviewPublicationOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(await readGithubIssue(input.localRef, input.route, repositories, dependencies));
  if (!current.ok) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'admission_failed' as const, failure: current.failure });
  }
  const entry = input.publicationPlan.entries[0];
  if (input.publicationPlan.entries.length !== 1 || entry === undefined
    || input.publicationPlan.verdict !== null
    || input.publicationPlan.baseRevision !== null
    || input.publicationPlan.headRevision !== null
  ) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unsupported_anchor' as const,
      observation: current.observation,
    });
  }
  const capability = await preflightGithubPublicationCapability({
    localRef: input.localRef,
    route: input.route,
    operation: 'issueComment',
  }, dependencies);
  if (!capability.ok) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'admission_failed' as const,
      observation: current.observation,
      failure: capability.failure,
    });
  }
  let claim: ReviewCommentClaimPublicationDispatchResponseV1;
  try {
    claim = await input.claimPublicationDispatch();
  } catch {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'dispatch_claim_failed' as const,
      observation: current.observation,
    });
  }
  const correlation = claim.entries[0];
  if (correlation === undefined) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'dispatch_claim_failed' as const,
      observation: current.observation,
    });
  }
  const marker = formatReviewCommentPublicationMarkerV1('entry', correlation.publicationCorrelationId);
  const reconcile = async (
    dispatchFailure?: TriageSourceFailureV1,
  ): Promise<GithubPullRequestReviewPublicationOutcomeV1> => {
    const comments = await readGithubIssueCommentPublicationRecords({
      route: input.route,
      number: input.localRef.entryId,
      repositoryId: readGithubRepositoryIdFromCollisionScope(input.localRef.collisionScope),
    }, dependencies);
    const matched = comments.failure === null && !comments.incomplete
      ? matchReviewCommentPublicationMarkerV1(
        comments.comments.map((comment) => ({ externalRef: comment.providerId, body: comment.body })),
        marker,
      )
      : { kind: 'absent' as const };
    const prior = claim.priorResult?.entries[0];
    const preservedOutcome = (claim.instructions.entries[0] === 'confirmed'
      || claim.instructions.entries[0] === 'held')
      ? prior?.outcome
      : undefined;
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(
      input.publicationPlan,
      claim,
      {
        publicationPlanId: claim.publicationPlanId,
        entries: [{
          happierCommentId: entry.happierCommentId,
          publicationCorrelationId: correlation.publicationCorrelationId,
          outcome: preservedOutcome ?? (matched.kind !== 'unique'
            ? { kind: 'uncertain' }
            : { kind: 'published', externalRef: matched.externalRef }),
        }],
        verdict: { kind: 'notRequested' },
      },
    );
    const settlementFailure = await recordGithubPublicationSettlement(
      input.settlePublicationDispatch,
      claim,
      publication,
    );
    const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
    return Object.freeze({
      kind: 'settled' as const,
      publication,
      ...(confirmed.ok ? { observation: confirmed.observation } : {}),
      ...(dispatchFailure !== undefined
        ? { failure: dispatchFailure }
        : comments.failure !== null
          ? { failure: toTriageFailure(comments.failure) }
          : settlementFailure !== undefined
            ? { failure: settlementFailure }
            : !confirmed.ok
              ? { failure: confirmed.failure }
              : {}),
    });
  };
  const rejectedPublication = async (
    failure: TriageSourceFailureV1,
  ): Promise<GithubPullRequestReviewPublicationOutcomeV1> => {
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(
      input.publicationPlan,
      claim,
      {
        publicationPlanId: claim.publicationPlanId,
        entries: [{
          happierCommentId: entry.happierCommentId,
          publicationCorrelationId: correlation.publicationCorrelationId,
          outcome: { kind: 'failed', code: failure.code },
        }],
        verdict: { kind: 'notRequested' },
      },
    );
    // A definite provider rejection is the reported failure even when the internal
    // settlement also fails: nothing was published, so the rejection is the outcome.
    await recordGithubPublicationSettlement(input.settlePublicationDispatch, claim, publication);
    const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
    return Object.freeze({
      kind: 'settled' as const,
      publication,
      ...(confirmed.ok ? { observation: confirmed.observation } : {}),
      failure,
    });
  };
  if (claim.disposition === 'reconcile') return await reconcile();
  const written = await send(dependencies, {
    url: issueUrl(input.route, input.localRef.entryId, 'comments'),
    method: 'POST',
    body: { body: `${entry.body}\n\n${marker}` },
  });
  if (!written.ok) return await reconcile(written.failure);
  const failure = !isGithubSuccessStatus(written.response.status)
    ? toTriageFailure(classifyGithubResponseFailure(written.response, dependencies.now()))
    : undefined;
  if (failure !== undefined && !isGithubWriteResponseAmbiguous(written.response)) {
    return await rejectedPublication(failure);
  }
  return await reconcile(failure);
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

  const isTarget = (facts: GithubIssueFactsV1): boolean =>
    facts.state === transition.target
    && (transition.target !== 'closed'
      || transition.stateReason === undefined
      || facts.stateReason === transition.stateReason);

  // Converging on the state GitHub already holds is answered from the read with no
  // request at all. The close classification is part of that state: completed and
  // not-planned are distinct provider claims, so one must not satisfy the other.
  if (isTarget(current.facts)) return alreadySatisfied(current);
  if (current.facts.state === transition.target) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }
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
  if (!written.ok) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      isTarget,
    );
  }
  if (isGithubWriteResponseAmbiguous(written.response)) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      isTarget,
    );
  }
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
    isTarget,
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
    await readGithubEntryMetadata(input.localRef, input.route, repositories, dependencies),
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
  if (!written.ok) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      (facts) => everyNameIsPresent(delta.observe(facts), input.named, delta.presentAfterwards),
    );
  }
  if (isGithubWriteResponseAmbiguous(written.response)) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      (facts) => everyNameIsPresent(delta.observe(facts), input.named, delta.presentAfterwards),
    );
  }
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
