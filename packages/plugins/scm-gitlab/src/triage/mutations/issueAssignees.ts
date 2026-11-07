import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { buildGitlabGraphqlUrl, requestGitlabJson } from '../http/gitlabClient.js';
import {
  GitlabIssueAssignInputV1Schema,
  type GitlabIssueAssignResultV1,
} from './contracts.js';
import { readGitlabGraphqlMutationErrors } from './graphqlDelta.js';
import { GITLAB_ISSUE_MUTATION_SUBJECT_V1 } from './issueRow.js';
import { runGitlabMemberDelta } from './memberDelta.js';
import { GITLAB_MUTATION_INPUT_INVALID_FAILURE } from './preflight.js';

const DOCUMENT = `mutation HappierIssueSetAssignees($projectPath: ID!, $iid: String!, $operationMode: MutationOperationMode!, $assigneeUsernames: [String!]!) {
  issueSetAssignees(input: { projectPath: $projectPath, iid: $iid, operationMode: $operationMode, assigneeUsernames: $assigneeUsernames }) {
    errors
  }
}`;

export async function assignGitlabIssue(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabIssueAssignResultV1> {
  const parsed = GitlabIssueAssignInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  const request = parsed.data;
  const result = await runGitlabMemberDelta({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_ISSUE_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedRevision,
    operation: request.operation,
    selected: request.assigneeUsernames,
    members: (row) => row.assigneeUsernames,
    write: async (preflight) => requestGitlabJson({
      invocation: preflight.dependencies.invocation,
      url: buildGitlabGraphqlUrl(preflight.route.origin),
      method: 'POST',
      body: { query: DOCUMENT, variables: {
        projectPath: preflight.route.repositoryKey,
        iid: preflight.route.iid,
        operationMode: request.operation === 'add' ? 'APPEND' : 'REMOVE',
        assigneeUsernames: request.assigneeUsernames,
      } },
      fetcher: preflight.dependencies.fetcher,
      signal: preflight.dependencies.signal,
      nowMs: preflight.dependencies.nowMs,
    }),
    mutationErrors: (body) => readGitlabGraphqlMutationErrors(body, 'issueSetAssignees'),
  }, context);
  return result.kind === 'changed' ? { kind: 'assigneesChanged', item: result.item } : result;
}
