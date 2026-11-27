import type { TriagePullRequestStatusV1, TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import type {
  ReviewCommentClaimPublicationDispatchResponseV1,
  ReviewCommentPublicationEntryV1,
  ReviewCommentPublicationPlanV1,
  ReviewCommentPublicationResultV1,
} from '@happier-dev/plugin-sdk/reviews';
import {
  formatReviewCommentPublicationMarkerV1,
  matchReviewCommentPublicationMarkerV1,
  preflightReviewCommentPublicationRoutingV1,
  validateReviewCommentPublicationResultAgainstPlanV1,
} from '@happier-dev/plugin-sdk/reviews';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { GITHUB_RESPONSE_FAILURE_CODE } from '../../observations/githubResponseFailure.js';

import { sendGithubRestRequest as send } from './http.js';

import {
  classifyGithubResponseFailure,
  isGithubSuccessStatus,
  isGithubWriteResponseAmbiguous,
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
import {
  readGithubPullRequestReviewCommentRecords,
  readGithubPullRequestReviewPublicationRecords,
} from '../reviews.js';
import type { GithubTriageEntryLocalRefV1 } from '../types.js';
import { readGithubRepositoryIdFromCollisionScope } from '../identity.js';
import { readGithubPullRequestStatusForAdmittedEntry } from '../detailOperations.js';
import {
  classifyGithubPullRequestMergeRequirementsV1,
  githubMergeRequirementAcknowledgementMatchesV1,
} from './mergeRequirements.js';

import type {
  GithubMergeMethodV1,
  GithubPullRequestReviewVerdictV1,
  GithubPullRequestMergeResultV1,
  GithubPullRequestNativeMergeResultV1,
  GithubSkippedRequirementV1,
} from './contracts.js';
import { sendGithubGraphqlRequest } from './graphql.js';
import {
  preflightGithubReviewThread,
  readGithubReviewThreadReplyPublicationRecords,
  sendGithubReviewThreadReply,
} from './reviewThread.js';
import { preflightGithubPublicationCapability } from './publicationCapability.js';
import {
  recordGithubPublicationSettlement,
  type GithubPublicationSettlementV1,
} from './publicationSettlement.js';

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
 * Head-pinned transitions compare the user's pin, never fill it. The
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

export type GithubMergeRefusalReasonV1 = Extract<GithubPullRequestMergeResultV1, { kind: 'refused' }>['reason'];

export type GithubPullRequestMergeOutcomeV1 = GithubPullRequestMergeResultV1;

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

export type GithubPullRequestReviewPublicationOutcomeV1 =
  | Readonly<{
    kind: 'settled';
    publication: ReviewCommentPublicationResultV1;
    observation?: ProjectedObservation;
    failure?: TriageSourceFailureV1;
  }>
  | Readonly<{
    kind: 'rejected';
    reason: 'invalid_input' | 'admission_failed' | 'base_advanced' | 'head_advanced' | 'dispatch_claim_failed'
      | 'unsupported_anchor' | 'state_changed' | 'provider_rejected';
    observation?: ProjectedObservation;
    failure?: TriageSourceFailureV1;
  }>
  ;

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
    overview: GithubPullRequestReadV1['overview'];
  }>
  | Readonly<{ ok: false; failure: TriageSourceFailureV1 }>;

function reduce(read: GithubPullRequestReadV1): Current {
  if (read.observation.kind === 'present' && read.facts !== null) {
    return Object.freeze({
      ok: true as const,
      facts: read.facts,
      observation: toTriageObservation(read.observation),
      overview: read.overview,
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

/**
 * The single confirming read every outcome that may have changed provider state
 * runs under the same caller-owned signal/lifetime as the write. The source
 * adds no private timer when the caller/platform supplied none.
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
  writeFailure?: TriageSourceFailureV1,
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
    : Object.freeze({ kind: 'uncertain' as const, observation: confirmed.observation,
      ...(writeFailure === undefined ? {} : { failure: writeFailure }) });
}

function alreadySatisfied(current: Current & Readonly<{ ok: true }>): Applied {
  return Object.freeze({
    kind: 'applied' as const,
    effect: 'alreadySatisfied' as const,
    observation: current.observation,
  });
}

// Sibling PR content edits share the same read reduction and wire writer.
export { reduce as reduceGithubPullRequestMutationRead, send as sendGithubPullRequestMutation };

function openResolver(dependencies: GithubMutationDependenciesV1): GithubRepositoryReaderV1 {
  return dependencies.repositories
    ?? createGithubRepositoryReader({ client: dependencies.client, now: dependencies.now });
}

/* --------------------------------------------------------- review publication */

const GITHUB_REVIEW_EVENT_BY_VERDICT: Readonly<
  Record<GithubPullRequestReviewVerdictV1, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'>
> = Object.freeze({
  approve: 'APPROVE',
  requestChanges: 'REQUEST_CHANGES',
  comment: 'COMMENT',
});

function githubReviewComment(
  entry: ReviewCommentPublicationEntryV1,
  publicationCorrelationId: string,
): Readonly<Record<string, unknown>> | null | undefined {
  const body = `${entry.body}\n\n${formatReviewCommentPublicationMarkerV1('entry', publicationCorrelationId)}`;
  if (entry.anchor.kind === 'file') {
    return Object.freeze({ path: entry.anchor.filePath, body, subject_type: 'file' });
  }
  if (entry.anchor.kind !== 'line' && entry.anchor.kind !== 'range') return null;
  if (entry.snapshot.kind !== 'text' || entry.snapshot.diffContext === undefined) return null;
  const side = entry.anchor.side ?? entry.snapshot.diffContext.side;
  const githubSide = side === 'before' ? 'LEFT' : 'RIGHT';
  if (entry.anchor.kind === 'line') {
    return Object.freeze({
      path: entry.anchor.filePath,
      line: entry.anchor.line,
      side: githubSide,
      body,
    });
  }
  if (entry.anchor.startLine === entry.anchor.endLine) {
    return Object.freeze({
      path: entry.anchor.filePath,
      line: entry.anchor.endLine,
      side: githubSide,
      body,
    });
  }
  return Object.freeze({
    path: entry.anchor.filePath,
    start_line: entry.anchor.startLine,
    start_side: githubSide,
    line: entry.anchor.endLine,
    side: githubSide,
    body,
  });
}

function supportsGithubReviewEntry(
  entry: ReviewCommentPublicationEntryV1,
  plan: ReviewCommentPublicationPlanV1,
  routesToVerdictSummary = false,
): boolean {
  if (routesToVerdictSummary) {
    if (entry.snapshot.kind !== 'text') return true;
    const diff = entry.snapshot.diffContext;
    return (diff === undefined
      || (diff.baseSha === plan.baseRevision && diff.headSha === plan.headRevision))
      && (diff?.startSha === undefined || diff.startSha === plan.baseRevision)
      && (entry.snapshot.commitSha === undefined || entry.snapshot.commitSha === plan.headRevision);
  }
  if ((entry.anchor.kind !== 'file' && entry.anchor.kind !== 'line' && entry.anchor.kind !== 'range')
    || entry.snapshot.kind !== 'text'
    || entry.snapshot.diffContext === undefined
  ) return false;
  const diff = entry.snapshot.diffContext;
  return diff.baseSha === plan.baseRevision
    && diff.headSha === plan.headRevision
    && (diff.startSha === undefined || diff.startSha === plan.baseRevision)
    && (entry.snapshot.commitSha === undefined || entry.snapshot.commitSha === plan.headRevision);
}

/**
 * Publishes one frozen canonical review plan through one provider request.
 *
 * The ordinary mutation owner supplies the whole lifecycle: current account
 * materialization happens above this function, and this leaf rereads the exact
 * pull request (including the repository read that proves the caller can still
 * access it), compares the observed head, dispatches once, and folds a fresh
 * source observation into every post-dispatch outcome.
 */
export async function publishGithubPullRequestReview(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    publicationPlan: ReviewCommentPublicationPlanV1;
    claimPublicationDispatch: () => Promise<ReviewCommentClaimPublicationDispatchResponseV1>;
    settlePublicationDispatch?: GithubPublicationSettlementV1;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestReviewPublicationOutcomeV1> {
  if (input.publicationPlan.verdict === null) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'invalid_input' as const });
  }
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'admission_failed' as const,
      failure: current.failure,
    });
  }
  if (current.facts.state !== 'open' || current.facts.merged) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }
  if (current.facts.reviewRevision?.baseSha !== input.publicationPlan.baseRevision) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'base_advanced' as const,
      observation: current.observation,
    });
  }
  if (current.facts.headRevision !== input.publicationPlan.headRevision) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'head_advanced' as const,
      observation: current.observation,
    });
  }
  const publicationRouting = preflightReviewCommentPublicationRoutingV1(input.publicationPlan);
  if (publicationRouting.kind === 'rejected') {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unsupported_anchor' as const,
      observation: current.observation,
    });
  }
  const verdictSummaryEntryIndexes = new Set(publicationRouting.verdictSummaryEntryIndexes);

  const capability = await preflightGithubPublicationCapability({
    localRef: input.localRef,
    route: input.route,
    operation: 'pullRequestSubmitReview',
  }, dependencies);
  if (!capability.ok) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'admission_failed' as const,
      observation: current.observation,
      failure: capability.failure,
    });
  }

  let claim: Awaited<ReturnType<typeof input.claimPublicationDispatch>>;
  try {
    claim = await input.claimPublicationDispatch();
  } catch (error) {
    if (isPluginError(error)) throw error;
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'dispatch_claim_failed' as const,
      observation: current.observation,
    });
  }
  const verdictMarker = claim.verdict === null
    ? null
    : formatReviewCommentPublicationMarkerV1('verdict', claim.verdict.publicationCorrelationId);
  const entryMarkers = claim.entries.map((correlation) => Object.freeze({
    happierCommentId: correlation.happierCommentId,
    marker: formatReviewCommentPublicationMarkerV1('entry', correlation.publicationCorrelationId),
  }));
  const correlationByCommentId = new Map(claim.entries.map((correlation) => (
    [correlation.happierCommentId, correlation.publicationCorrelationId] as const
  )));
  const orderedCorrelations = input.publicationPlan.entries.map((entry) => (
    correlationByCommentId.get(entry.happierCommentId)
  ));
  if (orderedCorrelations.some((correlation) => correlation === undefined)) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'dispatch_claim_failed' as const,
      observation: current.observation,
    });
  }
  // Prior-round entries already have a provider thread. Only fresh dispatch
  // needs a line address valid on the captured head of this Review.
  const unsupportedDispatch = input.publicationPlan.entries.some((entry, index) =>
    claim.instructions.entries[index] === 'dispatch'
    && !supportsGithubReviewEntry(entry, input.publicationPlan, verdictSummaryEntryIndexes.has(index)));
  if (unsupportedDispatch) {
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(input.publicationPlan, claim, {
      publicationPlanId: claim.publicationPlanId,
      entries: claim.entries.map((entry, index) => ({
        ...entry,
        outcome: claim.priorResult?.entries[index]?.outcome
          ?? (claim.instructions.entries[index] === 'dispatch'
            ? { kind: 'failed', code: 'unsupported_anchor' }
            : { kind: 'uncertain' }),
      })),
      verdict: claim.verdict === null ? { kind: 'notRequested' } : {
        ...claim.verdict,
        outcome: claim.priorResult && !('kind' in claim.priorResult.verdict)
          ? claim.priorResult.verdict.outcome : { kind: 'skippedPriorFailure' },
      },
    });
    const failure = await recordGithubPublicationSettlement(input.settlePublicationDispatch, claim, publication);
    return { kind: 'rejected', reason: 'unsupported_anchor', observation: current.observation,
      ...(failure !== undefined ? { failure } : {}) };
  }
  const projectedComments = input.publicationPlan.entries.map((entry, index) => (
    verdictSummaryEntryIndexes.has(index) || claim.instructions.entries[index] !== 'dispatch'
      ? undefined
      : githubReviewComment(entry, orderedCorrelations[index] as string)
  ));
  if (projectedComments.some((comment) => comment === null)) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unsupported_anchor' as const,
      observation: current.observation,
    });
  }
  const summaryEntries = publicationRouting.verdictSummaryEntryIndexes.map(
    (index) => input.publicationPlan.entries[index]!,
  );
  const dispatchSummaryEntries = publicationRouting.verdictSummaryEntryIndexes
    .filter((index) => claim.instructions.entries[index] === 'dispatch')
    .map((index) => input.publicationPlan.entries[index]!);
  const comments = projectedComments.filter(
    (comment): comment is Readonly<Record<string, unknown>> => comment !== null && comment !== undefined,
  );

  const reconcile = async (
    dispatchFailure?: TriageSourceFailureV1,
  ): Promise<GithubPullRequestReviewPublicationOutcomeV1> => {
    const unconfirmedDispatch = dispatchFailure?.code === GITHUB_RESPONSE_FAILURE_CODE.reviewOwnPullRequest
      ? { kind: 'failed' as const, code: dispatchFailure.code }
      : { kind: 'uncertain' as const };
    const reviewRead = verdictMarker === null && summaryEntries.length === 0
      ? Object.freeze({ reviews: [], failure: null, incomplete: false })
      : await readGithubPullRequestReviewPublicationRecords({
        route: input.route,
        number: input.localRef.entryId,
        repositoryId: readGithubRepositoryIdFromCollisionScope(input.localRef.collisionScope),
      }, dependencies);
    const confirmedComments = entryMarkers.length === 0
      ? Object.freeze({ comments: [], failure: null, incomplete: false })
      : await readGithubPullRequestReviewCommentRecords({
        route: input.route,
        number: input.localRef.entryId,
        repositoryId: readGithubRepositoryIdFromCollisionScope(input.localRef.collisionScope),
      }, dependencies);
    const publication = validateReviewCommentPublicationResultAgainstPlanV1(
      input.publicationPlan,
      claim,
      {
        publicationPlanId: claim.publicationPlanId,
        entries: input.publicationPlan.entries.map((entry, index) => {
          const correlation = claim.entries[index]!;
          const instruction = claim.instructions.entries[index]!;
          const prior = claim.priorResult?.entries[index];
          if ((instruction === 'confirmed' || instruction === 'held') && prior !== undefined) {
            return prior;
          }
          const marker = entryMarkers[index]!.marker;
          const comment = confirmedComments.failure === null && !confirmedComments.incomplete
            ? matchReviewCommentPublicationMarkerV1(
              confirmedComments.comments.map((candidate) => ({
                externalRef: candidate.providerId,
                body: candidate.body,
              })),
              marker,
            )
            : { kind: 'absent' as const };
          const review = reviewRead.failure === null && !reviewRead.incomplete
            ? matchReviewCommentPublicationMarkerV1(
              reviewRead.reviews.map((candidate) => ({
                externalRef: candidate.providerId,
                body: candidate.body,
              })),
              marker,
            )
            : { kind: 'absent' as const };
          const refs = [comment, review].flatMap((match) => match.kind === 'unique'
            ? [match.externalRef]
            : []);
          const externalRef = comment.kind === 'duplicate' || review.kind === 'duplicate' || refs.length !== 1
            ? undefined
            : refs[0];
          return Object.freeze({
            happierCommentId: entry.happierCommentId,
            publicationCorrelationId: correlation.publicationCorrelationId,
            outcome: externalRef === undefined
              ? Object.freeze(instruction === 'dispatch' ? unconfirmedDispatch : { kind: 'uncertain' as const })
              : Object.freeze({ kind: 'published' as const, externalRef }),
          });
        }),
        verdict: input.publicationPlan.verdict === null || claim.verdict === null
          ? Object.freeze({ kind: 'notRequested' as const })
          : (() => {
            const instruction = claim.instructions.verdict;
            const prior = claim.priorResult !== null && !('kind' in claim.priorResult.verdict)
              ? claim.priorResult.verdict
              : null;
            if ((instruction === 'confirmed' || instruction === 'held') && prior !== null) {
              return prior;
            }
            const review = reviewRead.failure === null && !reviewRead.incomplete
              ? matchReviewCommentPublicationMarkerV1(
                reviewRead.reviews.map((candidate) => ({
                  externalRef: candidate.providerId,
                  body: candidate.body,
                })),
                verdictMarker!,
              )
              : { kind: 'absent' as const };
            return Object.freeze({
              publicationCorrelationId: claim.verdict.publicationCorrelationId,
              outcome: review.kind !== 'unique'
                ? Object.freeze(instruction === 'dispatch' ? unconfirmedDispatch : { kind: 'uncertain' as const })
                : Object.freeze({ kind: 'published' as const, externalRef: review.externalRef }),
            });
          })(),
      },
    );
    const settlementFailure = await recordGithubPublicationSettlement(
      input.settlePublicationDispatch,
      claim,
      publication,
    );
    const confirmedPullRequest = await confirm(
      input.localRef,
      input.route,
      repositories,
      dependencies,
    );
    const readFailure = reviewRead.failure !== null
      ? toTriageFailure(reviewRead.failure)
      : confirmedComments.failure !== null
        ? toTriageFailure(confirmedComments.failure)
        : undefined;
    return Object.freeze({
      kind: 'settled' as const,
      publication,
      ...(confirmedPullRequest.ok ? { observation: confirmedPullRequest.observation } : {}),
      ...(dispatchFailure !== undefined
        ? { failure: dispatchFailure }
        : readFailure !== undefined
          ? { failure: readFailure }
          : settlementFailure !== undefined
            ? { failure: settlementFailure }
            : !confirmedPullRequest.ok
              ? { failure: confirmedPullRequest.failure }
              : {}),
    });
  };

  if (claim.disposition === 'reconcile') {
    return await reconcile();
  }

  const written = await send(dependencies, {
    url: `${pullRequestUrl(input.route, input.localRef.entryId)}/reviews`,
    method: 'POST',
    body: {
      commit_id: input.publicationPlan.headRevision,
      event: claim.instructions.verdict === 'dispatch'
        ? GITHUB_REVIEW_EVENT_BY_VERDICT[input.publicationPlan.verdict?.kind ?? 'comment']
        : GITHUB_REVIEW_EVENT_BY_VERDICT.comment,
      body: [
        input.publicationPlan.verdict.body,
        ...dispatchSummaryEntries.map((entry) => {
          const correlation = correlationByCommentId.get(entry.happierCommentId)!;
          return `${entry.body}\n\n${formatReviewCommentPublicationMarkerV1('entry', correlation)}`;
        }),
        ...(claim.instructions.verdict === 'dispatch' && verdictMarker !== null ? [verdictMarker] : []),
        // A partial retry can post new inline entries with an already settled
        // verdict. Mark that new review body with its dispatched entries, never
        // the settled verdict's marker, so both intake and reconciliation keep
        // their existing canonical publication identities.
        ...(claim.instructions.verdict === 'dispatch' ? [] : input.publicationPlan.entries.flatMap((entry, index) => (
          claim.instructions.entries[index] === 'dispatch' && !verdictSummaryEntryIndexes.has(index)
            ? [formatReviewCommentPublicationMarkerV1('entry', correlationByCommentId.get(entry.happierCommentId)!)]
            : []
        ))),
      ].join('\n\n'),
      comments,
    },
  });
  if (!written.ok) {
    return await reconcile(written.failure);
  }
  const responseFailure = !isGithubSuccessStatus(written.response.status)
    ? toTriageFailure(classifyGithubResponseFailure(written.response, dependencies.now()))
    : undefined;
  return await reconcile(responseFailure);
}

/**
 * Publishes one canonical Review Comment either as a new pinned diff comment or
 * as a reply to one existing provider-native review comment. Both paths consume
 * the same Reviews claim and marker/result validators as whole-review
 * publication; only their provider endpoint and revision precondition differ.
 */
export async function publishGithubPullRequestComment(
  input: Readonly<{
    localRef: GithubTriageEntryLocalRefV1;
    route: GithubRepositoryRouteV1;
    publicationPlan: ReviewCommentPublicationPlanV1;
    mode: 'create' | 'reply';
    threadId?: string;
    claimPublicationDispatch: () => Promise<ReviewCommentClaimPublicationDispatchResponseV1>;
    settlePublicationDispatch?: GithubPublicationSettlementV1;
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestReviewPublicationOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(
    await readGithubPullRequest(input.localRef, input.route, repositories, dependencies),
  );
  if (!current.ok) {
    return Object.freeze({ kind: 'rejected' as const, reason: 'admission_failed' as const, failure: current.failure });
  }
  const entry = input.publicationPlan.entries[0];
  if (input.publicationPlan.entries.length !== 1 || entry === undefined
    || input.publicationPlan.verdict !== null
  ) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unsupported_anchor' as const,
      observation: current.observation,
    });
  }
  if (input.mode === 'create') {
    if (typeof input.publicationPlan.baseRevision !== 'string'
      || typeof input.publicationPlan.headRevision !== 'string'
    ) {
      return Object.freeze({
        kind: 'rejected' as const,
        reason: 'unsupported_anchor' as const,
        observation: current.observation,
      });
    }
    if (current.facts.reviewRevision?.baseSha !== input.publicationPlan.baseRevision) {
      return Object.freeze({ kind: 'rejected' as const, reason: 'base_advanced' as const, observation: current.observation });
    }
    if (current.facts.headRevision !== input.publicationPlan.headRevision) {
      return Object.freeze({ kind: 'rejected' as const, reason: 'head_advanced' as const, observation: current.observation });
    }
  } else if (input.publicationPlan.baseRevision !== null
    || input.publicationPlan.headRevision !== null
    || input.threadId === undefined
  ) {
    return Object.freeze({
      kind: 'rejected' as const,
      reason: 'unsupported_anchor' as const,
      observation: current.observation,
    });
  } else {
    const thread = await preflightGithubReviewThread({
      localRef: input.localRef,
      route: input.route,
      threadId: input.threadId,
    }, dependencies);
    if (!thread.ok) {
      return Object.freeze({
        kind: 'rejected' as const,
        reason: 'state_changed' as const,
        observation: current.observation,
        failure: thread.failure,
      });
    }
  }

  const capability = await preflightGithubPublicationCapability({
    localRef: input.localRef,
    route: input.route,
    operation: input.mode === 'create'
      ? 'pullRequestReviewCommentCreate'
      : 'pullRequestThreadReply',
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
  } catch (error) {
    if (isPluginError(error)) throw error;
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
  let projected: Readonly<Record<string, unknown>> | null = null;
  if (input.mode === 'create' && claim.instructions.entries[0] === 'dispatch') {
    projected = supportsGithubReviewEntry(entry, input.publicationPlan)
      ? githubReviewComment(entry, correlation.publicationCorrelationId) ?? null
      : null;
    if (projected === null) {
      const publication = validateReviewCommentPublicationResultAgainstPlanV1(input.publicationPlan, claim, {
        publicationPlanId: claim.publicationPlanId,
        entries: [{ ...correlation, outcome: { kind: 'failed', code: 'unsupported_anchor' } }],
        verdict: { kind: 'notRequested' },
      });
      const failure = await recordGithubPublicationSettlement(input.settlePublicationDispatch, claim, publication);
      return Object.freeze({
        kind: 'rejected' as const,
        reason: 'unsupported_anchor' as const,
        observation: current.observation,
        ...(failure === undefined ? {} : { failure }),
      });
    }
  }

  const reconcile = async (
    dispatchFailure?: TriageSourceFailureV1,
  ): Promise<GithubPullRequestReviewPublicationOutcomeV1> => {
    const comments = input.mode === 'reply'
      ? await readGithubReviewThreadReplyPublicationRecords({
        localRef: input.localRef,
        route: input.route,
        threadId: input.threadId!,
      }, dependencies)
      : await readGithubPullRequestReviewCommentRecords({
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
  if (input.mode === 'create') {
    const written = await send(dependencies, {
      url: buildGithubApiUrl([
        'repos', input.route.owner, input.route.name, 'pulls', input.localRef.entryId, 'comments',
      ]),
      method: 'POST',
      body: { ...projected!, commit_id: input.publicationPlan.headRevision! },
    });
    if (!written.ok) return await reconcile(written.failure);
    if (isGithubSuccessStatus(written.response.status)) return await reconcile();
    const failure = toTriageFailure(
      classifyGithubResponseFailure(written.response, dependencies.now()),
    );
    return isGithubWriteResponseAmbiguous(written.response)
      ? await reconcile(failure)
      : await rejectedPublication(failure);
  }

  const written = await sendGithubReviewThreadReply({
      threadId: input.threadId!,
      body: `${entry.body}\n\n${marker}`,
    }, dependencies);
  if (!written.ok) {
    return !written.mayHaveChanged
      ? await rejectedPublication(written.failure)
      : await reconcile(written.failure);
  }
  return await reconcile();
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
    intent?: 'normal' | 'withoutWaiting';
    skippedRequirements?: readonly GithubSkippedRequirementV1[];
  }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestMergeOutcomeV1> {
  const repositories = openResolver(dependencies);
  const freshRead = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  const current = reduce(freshRead);
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

  const status = await readGithubPullRequestStatusForAdmittedEntry({
    localRef: input.localRef, route: input.route, client: dependencies.client, signal: dependencies.signal,
  }, freshRead, { includeBranchRules: input.intent === 'withoutWaiting' });
  dependencies.signal.throwIfAborted();
  if (status.kind === 'unavailable') {
    return { kind: 'failed', failure: status.failure };
  }
  if (status.branch?.headRevision !== undefined
    && status.branch.headRevision !== input.headRevision) {
    return { kind: 'refused', reason: 'head_advanced', observation: current.observation };
  }
  const requirements = classifyGithubPullRequestMergeRequirementsV1(status);
  if (requirements.structuralRefusal !== undefined) {
    return { kind: 'refused', reason: 'not_mergeable', observation: current.observation };
  }
  if (input.intent === 'withoutWaiting') {
    if (status.merge?.canMergeWithoutWaiting !== true) {
      return { kind: 'refused', reason: 'bypass_not_allowed', observation: current.observation };
    }
    if (!requirements.complete) {
      return { kind: 'refused', reason: 'requirements_unknown', observation: current.observation };
    }
    if (!githubMergeRequirementAcknowledgementMatchesV1(input.skippedRequirements ?? [], requirements.unmetRequirements)) {
      return { kind: 'refused', reason: 'requirements_changed',
        unmetRequirements: [...requirements.unmetRequirements], observation: current.observation };
    }
  } else if (requirements.unmetRequirements.length > 0) {
    return { kind: 'refused', reason: 'requirements_unmet',
      unmetRequirements: [...requirements.unmetRequirements], observation: current.observation };
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
  if (!written.ok) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      (facts) => facts.merged,
    );
  }

  const response = written.response;
  if (isGithubWriteResponseAmbiguous(response)) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      (facts) => facts.merged,
    );
  }
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

/* ------------------------------------------------------ native merge controls */

type GithubNativeMergeTransitionV1 =
  | Readonly<{ kind: 'enqueue'; expectedHeadSha: string }>
  | Readonly<{ kind: 'dequeue' }>
  | Readonly<{ kind: 'autoMerge'; expectedHeadSha: string; enabled: boolean; mergeMethod?: GithubMergeMethodV1 }>;

function nativeMergeTransitionSatisfied(
  transition: GithubNativeMergeTransitionV1,
  status: TriagePullRequestStatusV1,
  facts: GithubPullRequestFactsV1,
): boolean {
  switch (transition.kind) {
    case 'enqueue': return status.merge?.queue !== undefined && status.merge.queue !== null;
    case 'dequeue': return status.merge?.queue === null;
    case 'autoMerge': {
      const autoMerge = status.merge?.autoMerge;
      return transition.enabled && facts.merged
        || autoMerge !== undefined && autoMerge !== null && autoMerge.enabled === transition.enabled
          && (!transition.enabled || transition.mergeMethod === undefined || autoMerge.method === transition.mergeMethod);
    }
  }
}

/** GitHub owns execution; each explicit native transition is dispatched once. */
async function transitionGithubNativeMerge(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  transition: GithubNativeMergeTransitionV1,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestNativeMergeResultV1> {
  const repositories = openResolver(dependencies);
  const freshRead = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  const current = reduce(freshRead);
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  if ('expectedHeadSha' in transition && current.facts.headRevision !== transition.expectedHeadSha) {
    return { kind: 'refused', reason: 'head_advanced', observation: current.observation };
  }
  if (transition.kind === 'autoMerge' && transition.enabled && current.facts.merged) return alreadySatisfied(current);
  const status = await readGithubPullRequestStatusForAdmittedEntry({
    ...input, client: dependencies.client, signal: dependencies.signal,
  }, freshRead);
  dependencies.signal.throwIfAborted();
  if (status.kind !== 'status') return { kind: 'failed', failure: status.failure };
  if ('expectedHeadSha' in transition && status.branch?.headRevision !== transition.expectedHeadSha) {
    return { kind: 'refused', reason: 'head_advanced', observation: current.observation };
  }
  if (nativeMergeTransitionSatisfied(transition, status, current.facts)) return alreadySatisfied(current);
  if (transition.kind === 'autoMerge' && transition.enabled && status.merge?.autoMerge?.enabled === true) {
    return { kind: 'refused', reason: 'state_changed', observation: current.observation };
  }
  if (current.facts.state !== 'open' || current.facts.merged) {
    return { kind: 'refused', reason: 'state_changed', observation: current.observation };
  }
  if ((transition.kind === 'enqueue' || transition.kind === 'autoMerge' && transition.enabled)
    && classifyGithubPullRequestMergeRequirementsV1(status).structuralRefusal !== undefined) {
    return { kind: 'refused', reason: 'not_mergeable', observation: current.observation };
  }
  const merge = status.merge;
  const allowed = transition.kind === 'autoMerge'
    ? transition.enabled ? merge?.viewerCanEnableAutoMerge : merge?.viewerCanDisableAutoMerge
    : merge?.viewerCanUpdate;
  if (allowed !== true || !merge?.nodeId) {
    return { kind: 'refused', reason: 'operation_not_allowed', observation: current.observation };
  }
  if (transition.kind === 'autoMerge' && transition.enabled && merge.queueRequired !== true) {
    const repository = await repositories.read(input.route);
    if (repository.kind === 'readable' && repository.mergeSettings[transition.mergeMethod ?? 'merge'] === false) {
      return { kind: 'refused', reason: 'merge_method_not_allowed', observation: current.observation };
    }
  }
  const operation = transition.kind === 'enqueue' ? 'enqueuePullRequest'
    : transition.kind === 'dequeue' ? 'dequeuePullRequest'
      : transition.enabled ? 'enablePullRequestAutoMerge' : 'disablePullRequestAutoMerge';
  const inputType = transition.kind === 'enqueue' ? 'EnqueuePullRequestInput'
    : transition.kind === 'dequeue' ? 'DequeuePullRequestInput'
      : transition.enabled ? 'EnablePullRequestAutoMergeInput' : 'DisablePullRequestAutoMergeInput';
  const providerInput = {
    pullRequestId: merge.nodeId,
    ...('expectedHeadSha' in transition && (transition.kind === 'enqueue' || transition.enabled)
      ? { expectedHeadOid: transition.expectedHeadSha } : {}),
    ...(transition.kind === 'autoMerge' && transition.enabled && transition.mergeMethod !== undefined
      ? { mergeMethod: transition.mergeMethod.toUpperCase() } : {}),
  };
  // Dequeue and disable expose no atomic head guard. Their exact PR/node and
  // current head were re-admitted above; this does not claim provider CAS.
  dependencies.signal.throwIfAborted();
  const written = await sendGithubGraphqlRequest({
    query: `mutation GithubNativeMerge($input: ${inputType}!) { ${operation}(input: $input) { clientMutationId } }`,
    variables: { input: providerInput },
  }, dependencies);
  if (!written.ok && !written.mayHaveChanged) return { kind: 'failed', failure: written.failure };

  const confirmedRead = await readGithubPullRequest(input.localRef, input.route, repositories, dependencies);
  const confirmed = reduce(confirmedRead);
  if (!confirmed.ok) return { kind: 'uncertain', failure: confirmed.failure };
  if (transition.kind === 'autoMerge' && transition.enabled && confirmed.facts.merged) {
    return { kind: 'applied', effect: 'changed', observation: confirmed.observation };
  }
  const confirmedStatus = await readGithubPullRequestStatusForAdmittedEntry({
    ...input, client: dependencies.client, signal: dependencies.signal,
  }, confirmedRead);
  return confirmedStatus.kind === 'status' && nativeMergeTransitionSatisfied(transition, confirmedStatus, confirmed.facts)
    ? { kind: 'applied', effect: 'changed', observation: confirmed.observation }
    : { kind: 'uncertain', observation: confirmed.observation,
      ...(confirmedStatus.kind === 'unavailable' ? { failure: confirmedStatus.failure }
        : !written.ok ? { failure: written.failure } : {}) };
}

export async function enqueueGithubPullRequest(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1; expectedHeadSha: string }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestNativeMergeResultV1> {
  return transitionGithubNativeMerge(input, { kind: 'enqueue', expectedHeadSha: input.expectedHeadSha }, dependencies);
}

export async function dequeueGithubPullRequest(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestNativeMergeResultV1> {
  return transitionGithubNativeMerge(input, { kind: 'dequeue' }, dependencies);
}

export async function setGithubPullRequestAutoMerge(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1;
    expectedHeadSha: string; enabled: boolean; mergeMethod?: GithubMergeMethodV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestNativeMergeResultV1> {
  return transitionGithubNativeMerge(input, { kind: 'autoMerge', expectedHeadSha: input.expectedHeadSha,
    enabled: input.enabled, ...(input.mergeMethod === undefined ? {} : { mergeMethod: input.mergeMethod }) }, dependencies);
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

const CONVERT_TO_DRAFT_MUTATION = 'mutation ConvertToDraft($pullRequestId: ID!) {'
  + ' convertPullRequestToDraft(input: { pullRequestId: $pullRequestId })'
  + ' { pullRequest { id isDraft } } }';

async function writeGithubPullRequestDraftStatus(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  nodeId: string,
  draft: boolean,
  repositories: GithubRepositoryReaderV1,
  dependencies: GithubMutationDependenciesV1,
): Promise<Applied | Uncertain | Failed> {
  const written = await sendGithubGraphqlRequest({
    query: draft ? CONVERT_TO_DRAFT_MUTATION : MARK_READY_MUTATION,
    variables: { pullRequestId: nodeId },
  }, dependencies);
  if (!written.ok && !written.mayHaveChanged) return { kind: 'failed', failure: written.failure };
  // Confirm the resulting entity once whenever GitHub could have applied the write.
  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    facts => facts.draft === draft,
    written.ok ? undefined : written.failure,
  );
}

/** Withdraws ready status without pinning a commit set or summoning reviewers. */
export async function convertGithubPullRequestToDraft(
  input: Readonly<{ localRef: GithubTriageEntryLocalRefV1; route: GithubRepositoryRouteV1 }>,
  dependencies: GithubMutationDependenciesV1,
): Promise<GithubPullRequestStateOutcomeV1> {
  const repositories = openResolver(dependencies);
  const current = reduce(await readGithubPullRequest(input.localRef, input.route, repositories, dependencies));
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  if (current.facts.draft) return alreadySatisfied(current);
  if (current.facts.state !== 'open' || current.facts.merged) {
    return { kind: 'refused', reason: 'state_changed', observation: current.observation };
  }
  if (current.facts.nodeId === null) return { kind: 'failed', failure: ENTITY_ID_UNAVAILABLE_FAILURE };
  return writeGithubPullRequestDraftStatus(input, current.facts.nodeId, true, repositories, dependencies);
}

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

  return writeGithubPullRequestDraftStatus(input, current.facts.nodeId, false, repositories, dependencies);
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
 * GitHub's provider-computed `mergeable_state: 'behind'` is the positive
 * eligibility fact for this operation. `unknown`, omitted, and every other state
 * are not silently promoted to eligible: the control can be offered again after
 * an explicit refresh once GitHub has a decisive answer.
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
  if (current.facts.mergeableState !== 'behind') {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }

  const settlement = await settleAtMostOnceProviderWrite({
    dispatch: () => send(dependencies, {
      url: `${pullRequestUrl(input.route, input.localRef.entryId)}/update-branch`,
      method: 'PUT',
      body: { expected_head_sha: input.headRevision },
    }),
    // A transport failure or 5xx cannot say whether GitHub accepted the PUT.
    // A 4xx can, and keeps its status-specific handling below.
    mayHaveChanged: (result) => result.ok
      ? isGithubWriteResponseAmbiguous(result.response)
      : true,
    confirm: async (dispatched) => {
      const confirmed = await confirm(input.localRef, input.route, repositories, dependencies);
      if (!confirmed.ok) {
        return Object.freeze({ kind: 'uncertain' as const, failure: confirmed.failure });
      }
      if (confirmed.facts.headRevision !== null && confirmed.facts.headRevision !== input.headRevision) {
        return Object.freeze({ kind: 'applied' as const, observation: confirmed.observation });
      }
      const failure = dispatched.ok
        ? toTriageFailure(classifyGithubResponseFailure(dispatched.response, dependencies.now()))
        : dispatched.failure;
      return Object.freeze({ kind: 'uncertain' as const, observation: confirmed.observation, failure });
    },
  });
  if (settlement.kind === 'applied') {
    return Object.freeze({
      kind: 'applied' as const,
      effect: 'changed' as const,
      observation: settlement.observation,
    });
  }
  if (settlement.kind !== 'settled') {
    return Object.freeze({
      kind: 'uncertain' as const,
      ...(settlement.observation === undefined ? {} : { observation: settlement.observation }),
      ...('failure' in settlement && settlement.failure !== undefined ? { failure: settlement.failure } : {}),
    });
  }
  const written = settlement.result;
  // `mayHaveChanged` classifies every transport failure above, but the shared
  // generic deliberately cannot encode that provider-owned predicate as a type
  // refinement. Keep the impossible residual honest if the classifier changes.
  if (!written.ok) {
    return Object.freeze({ kind: 'uncertain' as const, failure: written.failure });
  }

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

  const isTarget = (facts: GithubPullRequestFactsV1): boolean =>
    facts.state === transition.target
    && (transition.target !== 'closed' || !facts.merged);

  // Closing and merging both leave GitHub's coarse `state` at `closed`, but they
  // are not the same outcome. A stale Close press that races with a merge must
  // report that the state changed; calling it already satisfied would claim the
  // requested non-merge transition happened when the pull request was actually
  // merged. Reopen has no equivalent ambiguity because a merged pull request is
  // never open.
  if (isTarget(current.facts)) return alreadySatisfied(current);
  if (current.facts.state === transition.target) {
    return Object.freeze({
      kind: 'refused' as const,
      reason: 'state_changed' as const,
      observation: current.observation,
    });
  }
  // A merged pull request has no reopen: the transition GitHub offers is
  // closed → open, and a merge is terminal. Refusing names why; writing would
  // produce a provider error the user cannot act on.
  const blocked = transition.target === 'open'
    ? current.facts.merged || current.facts.state !== 'closed'
    : current.facts.merged || current.facts.state !== 'open';
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
  if (!written.ok) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      isTarget,
    );
  }

  const response = written.response;
  if (isGithubWriteResponseAmbiguous(response)) {
    return settle(
      await confirm(input.localRef, input.route, repositories, dependencies),
      isTarget,
    );
  }
  if (!isGithubSuccessStatus(response.status)) {
    return Object.freeze({
      kind: 'failed' as const,
      failure: toTriageFailure(classifyGithubResponseFailure(response, dependencies.now())),
    });
  }
  return settle(
    await confirm(input.localRef, input.route, repositories, dependencies),
    isTarget,
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
