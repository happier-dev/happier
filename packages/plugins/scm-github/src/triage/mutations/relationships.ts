import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubApiClientV1 } from '../../observations/githubApiClient.js';
import { admitGithubEntryInvocation } from '../admission.js';
import { GITHUB_ROUTE_BODY_MISMATCH_FAILURE } from '../errors.js';
import { parseGithubRoutingToken } from '../locator.js';
import { sendGithubGraphqlRequest } from './graphql.js';
import { decodeGithubNodeEntry, githubNodeEntryMatches } from './nodeEntry.js';
import {
  GithubRelatedEntryInputV1Schema, GithubSubIssueAddInputV1Schema, GithubSubIssueReprioritizeInputV1Schema,
  GithubProjectItemAddInputV1Schema, GithubProjectItemRemoveInputV1Schema,
  GithubProjectFieldSetInputV1Schema, GithubProjectFieldClearInputV1Schema,
  type GithubRelationshipMutationResultV1,
} from './relationshipContracts.js';

type RelatedEntry = ReturnType<typeof GithubRelatedEntryInputV1Schema.parse>['related'];
type Dependencies = Readonly<{ client: GithubApiClientV1; now: () => number }>;
type Applied = Extract<GithubRelationshipMutationResultV1, { kind: 'applied' }>;
const INVALID_INPUT: TriageSourceFailureV1 = { class: 'unsupportedContract', code: 'github_mutation_input_invalid' };
function failed(failure: TriageSourceFailureV1): Extract<GithubRelationshipMutationResultV1, { kind: 'failed' }> {
  return { kind: 'failed', failure };
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nodeId(value: unknown): string | null {
  return record(value) && typeof value.id === 'string' && value.id !== '' ? value.id : null;
}

/** Exact entry lookup; shared node-entry decoding owns repository/number identity. No collection walk. */
async function readEntry(target: RelatedEntry, dependencies: Dependencies) {
  const route = parseGithubRoutingToken(target.routingToken);
  const kind = target.localRef.kindId;
  if (route === null || (kind !== 'issue' && kind !== 'pull-request')) return { ok: false as const, failure: INVALID_INPUT };
  const field = kind === 'issue' ? 'issue' : 'pullRequest';
  const response = await sendGithubGraphqlRequest({
    query: `query GithubRelationshipEntry($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { databaseId name owner { login }
        entry: ${field}(number: $number) { __typename id number }
      }
    }`,
    variables: { owner: route.owner, name: route.name, number: Number(target.localRef.entryId) },
    readOnlyGraphql: true,
  }, dependencies);
  if (!response.ok) return response;
  const repository = response.data.repository;
  const entry = record(repository) ? repository.entry : null;
  const identity = decodeGithubNodeEntry(entry, repository);
  const id = nodeId(entry);
  if (identity === null || id === null || !record(entry)
    || entry.__typename !== (kind === 'issue' ? 'Issue' : 'PullRequest')
    || !githubNodeEntryMatches(identity, { ...target.localRef, kindId: kind }, route)) {
    return { ok: false as const, failure: GITHUB_ROUTE_BODY_MISMATCH_FAILURE };
  }
  return { ok: true as const, id };
}

/**
 * Existing at-most-once settlement, using GitHub's atomic mutation payload as
 * the authoritative observation. No own-write reread, retry, or publication claim:
 * relationship writes publish no Reviews proposal. A lost payload stays uncertain.
 */
async function writeRelationship(
  mutation: Readonly<{ name: string; inputType: string; selection: string; operands: Readonly<Record<string, unknown>> }>,
  confirmPayload: (payload: Readonly<Record<string, unknown>>) => Applied | null,
  dependencies: Dependencies,
): Promise<GithubRelationshipMutationResultV1> {
  let confirmation: Readonly<{ kind: 'applied'; observation: Applied }>
    | Readonly<{ kind: 'uncertain'; failure?: TriageSourceFailureV1 }> = { kind: 'uncertain' };
  const settled = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      const response = await sendGithubGraphqlRequest({
        query: `mutation GithubRelationshipWrite($input: ${mutation.inputType}!) {
          result: ${mutation.name}(input: $input) { ${mutation.selection} }
        }`,
        variables: { input: mutation.operands },
      }, dependencies);
      if (response.ok) {
        const payload = response.data.result;
        const applied = record(payload) ? confirmPayload(payload) : null;
        confirmation = applied === null ? { kind: 'uncertain' } : { kind: 'applied', observation: applied };
      } else confirmation = { kind: 'uncertain', failure: response.failure };
      return response;
    },
    mayHaveChanged: response => response.ok || response.mayHaveChanged,
    confirm: async () => confirmation,
  });
  if (settled.kind === 'applied') return settled.observation;
  if (settled.kind === 'uncertain') return settled;
  if (settled.kind === 'settled' && !settled.result.ok) return failed(settled.result.failure);
  return { kind: 'uncertain' };
}

type RelatedWrite = 'closingAdd' | 'closingRemove' | 'subAdd' | 'subRemove' | 'subReprioritize'
  | 'blockedByAdd' | 'blockedByRemove' | 'blockingAdd' | 'blockingRemove';

async function relatedWrite(input: unknown, context: PluginInvocationContext, operation: RelatedWrite): Promise<GithubRelationshipMutationResultV1> {
  const parsed = operation === 'subAdd' ? { operation, ...GithubSubIssueAddInputV1Schema.safeParse(input) }
    : operation === 'subReprioritize' ? { operation, ...GithubSubIssueReprioritizeInputV1Schema.safeParse(input) }
      : { operation, ...GithubRelatedEntryInputV1Schema.safeParse(input) };
  if (!parsed.success) return failed(INVALID_INPUT);
  const request = parsed.data;
  const closing = operation === 'closingAdd' || operation === 'closingRemove';
  // The pair's kinds are input constraints, not a second authorization decision.
  if (closing ? !((request.localRef.kindId === 'issue' && request.related.localRef.kindId === 'pull-request')
    || (request.localRef.kindId === 'pull-request' && request.related.localRef.kindId === 'issue'))
    : request.related.localRef.kindId !== 'issue') return failed(INVALID_INPUT);
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: closing ? ['issue', 'pull-request'] : ['issue'] }, context);
  if (!admitted.ok) return failed(admitted.failure);
  const dependencies = { client: admitted.client, now: Date.now };
  const primary = await readEntry(request, dependencies);
  if (!primary.ok) return failed(primary.failure);
  const related = await readEntry(request.related, dependencies);
  if (!related.ok) return failed(related.failure);
  const applied: Applied = { kind: 'applied', effect: 'changed', localRef: admitted.localRef, related: request.related };
  if (closing) {
    const issueId = admitted.kindId === 'issue' ? primary.id : related.id;
    const pullRequestId = admitted.kindId === 'pull-request' ? primary.id : related.id;
    const name = operation === 'closingAdd' ? 'addCloseIssueReferences' : 'removeCloseIssueReferences';
    return writeRelationship({ name, inputType: operation === 'closingAdd' ? 'AddCloseIssueReferencesInput' : 'RemoveCloseIssueReferencesInput',
      selection: 'issue { id }', operands: { issueId, pullRequestIds: [pullRequestId] } },
    payload => nodeId(payload.issue) === issueId ? applied : null, dependencies);
  }
  if (parsed.operation === 'subReprioritize') {
    const request = parsed.data;
    const anchor = 'before' in request ? request.before : request.after;
    if (anchor.localRef.kindId !== 'issue') return failed(INVALID_INPUT);
    const position = await readEntry(anchor, dependencies);
    if (!position.ok) return failed(position.failure);
    return writeRelationship({ name: 'reprioritizeSubIssue', inputType: 'ReprioritizeSubIssueInput', selection: 'issue { id }',
      operands: { issueId: primary.id, subIssueId: related.id, ...('before' in request ? { beforeId: position.id } : { afterId: position.id }) } },
    payload => nodeId(payload.issue) === primary.id ? applied : null, dependencies);
  }
  if (operation === 'subAdd' || operation === 'subRemove') {
    return writeRelationship({ name: operation === 'subAdd' ? 'addSubIssue' : 'removeSubIssue',
      inputType: operation === 'subAdd' ? 'AddSubIssueInput' : 'RemoveSubIssueInput', selection: 'issue { id } subIssue { id }',
      operands: { issueId: primary.id, subIssueId: related.id,
        ...(parsed.operation === 'subAdd' && parsed.data.replaceParent !== undefined
          ? { replaceParent: parsed.data.replaceParent } : {}) } },
    payload => nodeId(payload.issue) === primary.id && nodeId(payload.subIssue) === related.id ? applied : null, dependencies);
  }
  // GitHub owns one blocked-by edge. The Blocking controls invert the operands at this same owner.
  const reverse = operation === 'blockingAdd' || operation === 'blockingRemove';
  const issueId = reverse ? related.id : primary.id;
  const blockingIssueId = reverse ? primary.id : related.id;
  const add = operation === 'blockedByAdd' || operation === 'blockingAdd';
  return writeRelationship({ name: add ? 'addBlockedBy' : 'removeBlockedBy', inputType: add ? 'AddBlockedByInput' : 'RemoveBlockedByInput',
    selection: 'issue { id } blockingIssue { id }', operands: { issueId, blockingIssueId } },
  payload => nodeId(payload.issue) === issueId && nodeId(payload.blockingIssue) === blockingIssueId ? applied : null, dependencies);
}

async function projectWrite(input: unknown, context: PluginInvocationContext, operation: 'add' | 'remove' | 'set' | 'clear'): Promise<GithubRelationshipMutationResultV1> {
  const parsed = operation === 'add' ? { operation, ...GithubProjectItemAddInputV1Schema.safeParse(input) }
    : operation === 'remove' ? { operation, ...GithubProjectItemRemoveInputV1Schema.safeParse(input) }
      : operation === 'set' ? { operation, ...GithubProjectFieldSetInputV1Schema.safeParse(input) }
        : { operation, ...GithubProjectFieldClearInputV1Schema.safeParse(input) };
  if (!parsed.success) return failed(INVALID_INPUT);
  const request = parsed.data;
  const admitted = await admitGithubEntryInvocation({ ...request, admissibleKinds: ['issue', 'pull-request'] }, context);
  if (!admitted.ok) return failed(admitted.failure);
  const dependencies = { client: admitted.client, now: Date.now };
  const primary = await readEntry(request, dependencies);
  if (!primary.ok) return failed(primary.failure);
  if (parsed.operation !== 'add') {
    const request = parsed.data;
    const read = await sendGithubGraphqlRequest({
      query: `query GithubRelationshipProjectItem($id: ID!) {
        node(id: $id) { __typename ... on ProjectV2Item { id project { id }
          content { ... on Issue { id } ... on PullRequest { id } }
        } }
      }`, variables: { id: request.itemId }, readOnlyGraphql: true,
    }, dependencies);
    if (!read.ok) return failed(read.failure);
    const item = read.data.node;
    if (!record(item) || item.__typename !== 'ProjectV2Item' || nodeId(item) !== request.itemId
      || nodeId(item.project) !== request.projectId || nodeId(item.content) !== primary.id) return failed(GITHUB_ROUTE_BODY_MISMATCH_FAILURE);
  }
  const applied: Applied = { kind: 'applied', effect: 'changed', localRef: admitted.localRef, projectId: request.projectId,
    ...(parsed.operation !== 'add' ? { itemId: parsed.data.itemId } : {}),
    ...(parsed.operation === 'set' || parsed.operation === 'clear' ? { fieldId: parsed.data.fieldId } : {}) };
  if (parsed.operation === 'add') return writeRelationship({ name: 'addProjectV2ItemById', inputType: 'AddProjectV2ItemByIdInput',
    selection: 'item { id project { id } content { ... on Issue { id } ... on PullRequest { id } } }',
    operands: { projectId: request.projectId, contentId: primary.id } }, payload => {
    const item = payload.item;
    const itemId = nodeId(item);
    return record(item) && itemId !== null && nodeId(item.project) === request.projectId && nodeId(item.content) === primary.id
      ? { ...applied, itemId } : null;
  }, dependencies);
  const projectRequest = parsed.data;
  if (parsed.operation === 'remove') return writeRelationship({ name: 'deleteProjectV2Item', inputType: 'DeleteProjectV2ItemInput',
    selection: 'deletedItemId', operands: { projectId: projectRequest.projectId, itemId: projectRequest.itemId } },
  payload => payload.deletedItemId === projectRequest.itemId ? applied : null, dependencies);
  const fieldRequest = parsed.data;
  return writeRelationship({ name: operation === 'set' ? 'updateProjectV2ItemFieldValue' : 'clearProjectV2ItemFieldValue',
    inputType: operation === 'set' ? 'UpdateProjectV2ItemFieldValueInput' : 'ClearProjectV2ItemFieldValueInput', selection: 'projectV2Item { id }',
    operands: { projectId: fieldRequest.projectId, itemId: fieldRequest.itemId, fieldId: fieldRequest.fieldId,
      ...(parsed.operation === 'set' ? { value: parsed.data.value } : {}) } },
  payload => nodeId(payload.projectV2Item) === fieldRequest.itemId ? applied : null, dependencies);
}

export const addGithubClosingReferenceAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'closingAdd');
export const removeGithubClosingReferenceAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'closingRemove');
export const addGithubSubIssueAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'subAdd');
export const removeGithubSubIssueAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'subRemove');
export const reprioritizeGithubSubIssueAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'subReprioritize');
export const addGithubBlockedByAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'blockedByAdd');
export const removeGithubBlockedByAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'blockedByRemove');
export const addGithubBlockingAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'blockingAdd');
export const removeGithubBlockingAction = (input: unknown, context: PluginInvocationContext) => relatedWrite(input, context, 'blockingRemove');
export const addGithubProjectItemAction = (input: unknown, context: PluginInvocationContext) => projectWrite(input, context, 'add');
export const removeGithubProjectItemAction = (input: unknown, context: PluginInvocationContext) => projectWrite(input, context, 'remove');
export const setGithubProjectFieldAction = (input: unknown, context: PluginInvocationContext) => projectWrite(input, context, 'set');
export const clearGithubProjectFieldAction = (input: unknown, context: PluginInvocationContext) => projectWrite(input, context, 'clear');
