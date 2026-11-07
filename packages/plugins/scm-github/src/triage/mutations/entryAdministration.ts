import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { admitGithubEntryInvocation } from '../admission.js';
import { readGithubEntryMetadata, projectGithubIssueDeletion } from '../get.js';
import { buildGithubEntryLocalRef } from '../identity.js';
import { parseGithubRoutingToken } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import { GithubEntryAdministrationInputV1Schema, GithubIssueTransferInputV1Schema, GithubPullRequestRevertInputV1Schema,
  type GithubEntryAdministrationResultV1 } from './contracts.js';
import { settleGithubGraphqlMutation } from './graphql.js';
import { reduceGithubEntryMutationRead } from './issue.js';

type Target = ReturnType<typeof GithubEntryAdministrationInputV1Schema.parse>;
type Operation = Readonly<{ kind: 'transfer'; destinationRepository: string; createLabelsIfMissing?: boolean }>
  | Readonly<{ kind: 'revert'; title?: string; body?: string; draft?: boolean }>
  | Readonly<{ kind: 'delete' | 'pin' | 'unpin' | 'subscribe' | 'unsubscribe' }>;
type Applied = Extract<GithubEntryAdministrationResultV1, { kind: 'applied' }>;
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function invoke<T extends Target>(schema: ProtocolComposableSchema<T>, input: unknown,
  context: PluginInvocationContext, operationFor: (request: T) => Operation): Promise<GithubEntryAdministrationResultV1> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_mutation_input_invalid' } };
  const operation = operationFor(parsed.data);
  const destinationRoute = operation.kind === 'transfer' ? parseGithubRoutingToken(operation.destinationRepository) : null;
  if (operation.kind === 'transfer' && destinationRoute === null) return { kind: 'failed',
    failure: { class: 'unsupportedContract', code: 'github_mutation_input_invalid' } };
  const subscription = operation.kind === 'subscribe' || operation.kind === 'unsubscribe';
  const admitted = await admitGithubEntryInvocation({ ...parsed.data,
    admissibleKinds: subscription ? ['issue', 'pull-request'] : operation.kind === 'revert' ? ['pull-request'] : ['issue'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const repositories = createGithubRepositoryReader(dependencies);
  const current = reduceGithubEntryMutationRead(await readGithubEntryMetadata(admitted.localRef, admitted.route,
    repositories, dependencies));
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  const id = current.facts.nodeId;
  if (id === null) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_entity_id_unavailable' } };
  let destinationId: string | undefined;
  if (operation.kind === 'transfer' && destinationRoute !== null) {
    const destination = await repositories.read(destinationRoute);
    if (destination.kind === 'unreadable') return { kind: 'failed', failure: toTriageFailure(destination.failure) };
    if (!destination.nodeId) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_entity_id_unavailable' } };
    destinationId = destination.nodeId;
  }
  const nativeState = operation.kind === 'subscribe' ? 'SUBSCRIBED' : 'UNSUBSCRIBED';
  const request = operation.kind === 'revert' ? {
    name: 'revertPullRequest', query: `mutation GithubRevertPullRequest($pullRequestId: ID!, $title: String, $body: String, $draft: Boolean) {
      revertPullRequest(input: { pullRequestId: $pullRequestId, title: $title, body: $body, draft: $draft }) {
        pullRequest { id } revertPullRequest { id number url repository { databaseId name owner { login } } } } }`,
    variables: { pullRequestId: id, ...(operation.title === undefined ? {} : { title: operation.title }),
      ...(operation.body === undefined ? {} : { body: operation.body }), ...(operation.draft === undefined ? {} : { draft: operation.draft }) },
  } : operation.kind === 'transfer' ? {
    name: 'transferIssue', query: `mutation GithubTransferIssue($issueId: ID!, $repositoryId: ID!, $createLabelsIfMissing: Boolean) {
      transferIssue(input: { issueId: $issueId, repositoryId: $repositoryId, createLabelsIfMissing: $createLabelsIfMissing }) {
        issue { id number url repository { id databaseId name owner { login } } } } }`,
    variables: { issueId: id, repositoryId: destinationId,
      ...(operation.createLabelsIfMissing === undefined ? {} : { createLabelsIfMissing: operation.createLabelsIfMissing }) },
  } : operation.kind === 'delete' ? {
    name: 'deleteIssue', query: `mutation GithubDeleteIssue($issueId: ID!) {
      deleteIssue(input: { issueId: $issueId }) { repository { databaseId } } }`, variables: { issueId: id },
  } : subscription ? {
    name: 'updateSubscription', query: `mutation GithubEntrySubscription($subscribableId: ID!, $state: SubscriptionState!) {
      updateSubscription(input: { subscribableId: $subscribableId, state: $state }) { subscribable { id viewerSubscription } } }`,
    variables: { subscribableId: id, state: nativeState },
  } : {
    name: operation.kind === 'pin' ? 'pinIssue' : 'unpinIssue',
    query: `mutation GithubIssuePin($issueId: ID!) {
      ${operation.kind === 'pin' ? 'pinIssue' : 'unpinIssue'}(input: { issueId: $issueId }) { issue { id isPinned } } }`,
    variables: { issueId: id },
  };
  const project = (payload: unknown): Applied | null => {
    if (!record(payload)) return null;
    if (operation.kind === 'revert') {
      const created = payload.revertPullRequest;
      if (!record(payload.pullRequest) || payload.pullRequest.id !== id || !record(created)
        || typeof created.id !== 'string' || !created.id || typeof created.url !== 'string' || !created.url
        || !record(created.repository)) return null;
      const localRef = buildGithubEntryLocalRef({ kindId: 'pull-request', repositoryId: created.repository.databaseId, nativeItemId: created.number });
      if (localRef === null || localRef.collisionScope !== admitted.localRef.collisionScope || localRef.entryId === admitted.localRef.entryId) return null;
      return { kind: 'applied', effect: 'changed', entry: { id: created.id, localRef, url: created.url,
        routingToken: `${admitted.route.owner}/${admitted.route.name}` } };
    }
    if (operation.kind === 'delete') {
      const observation = projectGithubIssueDeletion(admitted.localRef, payload);
      return observation === null ? null : { kind: 'applied', effect: 'changed', entry: { id }, observation };
    }
    const entry = subscription ? payload.subscribable : payload.issue;
    if (!record(entry) || entry.id !== id) return null;
    if (operation.kind === 'transfer') {
      const repository = entry.repository;
      if (!record(repository) || repository.id !== destinationId || !record(repository.owner)) return null;
      const successor = buildGithubEntryLocalRef({ kindId: 'issue', repositoryId: repository.databaseId, nativeItemId: entry.number });
      const route = typeof repository.owner.login === 'string' && typeof repository.name === 'string'
        ? parseGithubRoutingToken(`${repository.owner.login}/${repository.name}`) : null;
      if (successor === null || route === null || typeof entry.url !== 'string' || !entry.url) return null;
      return { kind: 'applied', effect: 'changed', entry: { id, url: entry.url, routingToken: `${route.owner}/${route.name}` },
        observation: { kind: 'merged', localRef: admitted.localRef, successor } };
    }
    if (subscription) return entry.viewerSubscription === nativeState
      ? { kind: 'applied', effect: 'changed', entry: { id, subscription: nativeState } } : null;
    const pinned = operation.kind === 'pin';
    return entry.isPinned === pinned ? { kind: 'applied', effect: 'changed', entry: { id, pinned } } : null;
  };
  return settleGithubGraphqlMutation(request, data => project(data[request.name]), dependencies);
}

export const transferGithubIssueAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubIssueTransferInputV1Schema, input, context, request => ({ kind: 'transfer', destinationRepository: request.destinationRepository,
    ...(request.createLabelsIfMissing === undefined ? {} : { createLabelsIfMissing: request.createLabelsIfMissing }) }));
export const deleteGithubIssueAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubEntryAdministrationInputV1Schema, input, context, () => ({ kind: 'delete' }));
export const pinGithubIssueAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubEntryAdministrationInputV1Schema, input, context, () => ({ kind: 'pin' }));
export const unpinGithubIssueAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubEntryAdministrationInputV1Schema, input, context, () => ({ kind: 'unpin' }));
export const subscribeGithubEntryAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubEntryAdministrationInputV1Schema, input, context, () => ({ kind: 'subscribe' }));
export const unsubscribeGithubEntryAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubEntryAdministrationInputV1Schema, input, context, () => ({ kind: 'unsubscribe' }));
export const revertGithubPullRequestAction = (input: unknown, context: PluginInvocationContext): Promise<GithubEntryAdministrationResultV1> =>
  invoke(GithubPullRequestRevertInputV1Schema, input, context, request => ({ kind: 'revert',
    ...(request.title === undefined ? {} : { title: request.title }), ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.draft === undefined ? {} : { draft: request.draft }) }));
