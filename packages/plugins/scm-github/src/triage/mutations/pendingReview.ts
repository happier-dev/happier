import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import type { TriageSourceObservationV1 } from '@happier-dev/triage-protocol/v1';
import { admitGithubEntryInvocation } from '../admission.js';
import { GITHUB_ROUTE_BODY_MISMATCH_FAILURE } from '../errors.js';
import { readGithubPullRequest } from '../get.js';
import { createGithubRepositoryReader } from '../repositories.js';
import {
  GithubPullRequestPendingReviewCreateInputV1Schema, GithubPullRequestPendingReviewSubmitInputV1Schema,
  GithubPullRequestPendingReviewDeleteInputV1Schema, GithubPullRequestReviewDismissInputV1Schema,
  type GithubPullRequestReviewMutationResultV1, type GithubPullRequestReviewVerdictV1,
  type GithubPullRequestCloseInputV1,
} from './contracts.js';
import { sendGithubGraphqlRequest, settleGithubGraphqlMutation } from './graphql.js';
import { decodeGithubNodeEntry, githubNodeEntryMatches } from './nodeEntry.js';
import { reduceGithubPullRequestMutationRead } from './pullRequest.js';

type Operation = Readonly<{ kind: 'create'; headRevision: string; body?: string }>
  | Readonly<{ kind: 'submit'; reviewId: string; headRevision: string; verdict: GithubPullRequestReviewVerdictV1; body?: string }>
  | Readonly<{ kind: 'delete'; reviewId: string }>
  | Readonly<{ kind: 'dismiss'; reviewId: string; message: string }>;
const reviewTargetQuery = (withHead: boolean) => `query GithubReviewMutationTarget($id: ID!) {
  node(id: $id) { __typename ... on PullRequestReview {
    id ${withHead ? 'commit { oid }' : ''}
    pullRequest { number ${withHead ? 'headRefOid' : ''} repository { databaseId name owner { login } } }
  } }
}`;
const REVIEW_FIELDS = '{ pullRequestReview { id state body } }';
const EVENTS = { approve: 'APPROVE', requestChanges: 'REQUEST_CHANGES', comment: 'COMMENT' } as const;
const STATES = { approve: 'APPROVED', requestChanges: 'CHANGES_REQUESTED', comment: 'COMMENTED' } as const;
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GitHub owns the draft lifecycle; the source proves the selected review's parent once. */
async function invoke<T extends GithubPullRequestCloseInputV1>(schema: ProtocolComposableSchema<T>, input: unknown,
  context: PluginInvocationContext, operationFor: (request: T) => Operation): Promise<GithubPullRequestReviewMutationResultV1> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_mutation_input_invalid' } };
  const admitted = await admitGithubEntryInvocation({ ...parsed.data, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const operation = operationFor(parsed.data);
  let observation: TriageSourceObservationV1 | undefined;
  let pullRequestId: string | undefined;
  if (operation.kind === 'create') {
    const current = reduceGithubPullRequestMutationRead(await readGithubPullRequest(admitted.localRef, admitted.route,
      createGithubRepositoryReader(dependencies), dependencies));
    if (!current.ok) return { kind: 'failed', failure: current.failure };
    if (current.facts.nodeId === null) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_entity_id_unavailable' } };
    pullRequestId = current.facts.nodeId;
    observation = current.observation;
  } else {
    const read = await sendGithubGraphqlRequest({ query: reviewTargetQuery(operation.kind === 'submit'), variables: { id: operation.reviewId }, readOnlyGraphql: true }, dependencies);
    if (!read.ok) return { kind: 'failed', failure: read.failure };
    const node = read.data.node;
    const pullRequest = record(node) && record(node.pullRequest) ? node.pullRequest : null;
    const parent = pullRequest === null ? null : decodeGithubNodeEntry(pullRequest, pullRequest.repository);
    if (!record(node) || node.__typename !== 'PullRequestReview' || node.id !== operation.reviewId
      || parent === null || !githubNodeEntryMatches(parent, admitted.localRef, admitted.route)) {
      return { kind: 'failed', failure: GITHUB_ROUTE_BODY_MISMATCH_FAILURE };
    }
    if (operation.kind === 'submit') {
      if (!record(node.commit) || typeof node.commit.oid !== 'string' || typeof pullRequest?.headRefOid !== 'string') {
        return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_entity_id_unavailable' } };
      }
      if (pullRequest.headRefOid !== operation.headRevision) return { kind: 'refused', reason: 'head_advanced' };
      if (node.commit.oid !== operation.headRevision) return { kind: 'refused', reason: 'state_changed' };
    }
  }
  const request = operation.kind === 'create' ? {
    mutation: 'addPullRequestReview', state: 'PENDING',
    query: `mutation GithubPendingReviewCreate($pullRequestId: ID!, $commitOID: GitObjectID!, $body: String) {
      addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, body: $body }) ${REVIEW_FIELDS} }`,
    variables: { pullRequestId, commitOID: operation.headRevision, ...(operation.body === undefined ? {} : { body: operation.body }) },
  } : operation.kind === 'submit' ? {
    mutation: 'submitPullRequestReview', state: STATES[operation.verdict],
    query: `mutation GithubPendingReviewSubmit($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
      submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) ${REVIEW_FIELDS} }`,
    variables: { reviewId: operation.reviewId, event: EVENTS[operation.verdict], ...(operation.body === undefined ? {} : { body: operation.body }) },
  } : operation.kind === 'delete' ? {
    mutation: 'deletePullRequestReview', state: null,
    query: `mutation GithubPendingReviewDelete($reviewId: ID!) {
      deletePullRequestReview(input: { pullRequestReviewId: $reviewId }) ${REVIEW_FIELDS} }`,
    variables: { reviewId: operation.reviewId },
  } : {
    mutation: 'dismissPullRequestReview', state: 'DISMISSED',
    query: `mutation GithubReviewDismiss($reviewId: ID!, $message: String!) {
      dismissPullRequestReview(input: { pullRequestReviewId: $reviewId, message: $message }) ${REVIEW_FIELDS} }`,
    variables: { reviewId: operation.reviewId, message: operation.message },
  };
  return settleGithubGraphqlMutation<Extract<GithubPullRequestReviewMutationResultV1, { kind: 'applied' }>>(request, data => {
    const payload = data[request.mutation];
    const review = record(payload) ? payload.pullRequestReview : null;
    if (!record(review) || typeof review.id !== 'string' || !review.id || typeof review.state !== 'string' || !review.state
      || (operation.kind !== 'create' && review.id !== operation.reviewId)
      || (request.state !== null && review.state !== request.state)) return null;
    return { kind: 'applied', effect: 'changed', ...(observation === undefined ? {} : { observation }),
      review: { id: review.id, state: review.state, ...(typeof review.body === 'string' ? { body: review.body } : {}) } };
  }, dependencies);
}

export const createGithubPendingReviewAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestReviewMutationResultV1> =>
  invoke(GithubPullRequestPendingReviewCreateInputV1Schema, input, context, request => ({ kind: 'create', headRevision: request.headRevision,
    ...(request.body === undefined ? {} : { body: request.body }) }));
export const submitGithubPendingReviewAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestReviewMutationResultV1> =>
  invoke(GithubPullRequestPendingReviewSubmitInputV1Schema, input, context, request => ({ kind: 'submit', reviewId: request.reviewId, headRevision: request.headRevision, verdict: request.verdict,
    ...(request.body === undefined ? {} : { body: request.body }) }));
export const deleteGithubPendingReviewAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestReviewMutationResultV1> =>
  invoke(GithubPullRequestPendingReviewDeleteInputV1Schema, input, context, request => ({ kind: 'delete', reviewId: request.reviewId }));
export const dismissGithubReviewAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestReviewMutationResultV1> =>
  invoke(GithubPullRequestReviewDismissInputV1Schema, input, context, request => ({ kind: 'dismiss', reviewId: request.reviewId, message: request.message }));
