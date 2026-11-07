import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { buildGitlabGraphqlUrl, requestGitlabJson } from '../http/gitlabClient.js';
import {
  GitlabMergeRequestReviewerChangeInputV1Schema,
  type GitlabMergeRequestReviewerChangeResultV1,
} from './contracts.js';
import { readGitlabGraphqlMutationErrors } from './graphqlDelta.js';
import { runGitlabMemberDelta } from './memberDelta.js';
import { GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1 } from './mergeRequestRow.js';
import { GITLAB_MUTATION_INPUT_INVALID_FAILURE } from './preflight.js';

const DOCUMENT = `mutation HappierMergeRequestSetReviewers($projectPath: ID!, $iid: String!, $operationMode: MutationOperationMode!, $reviewerUsernames: [String!]!) {
  mergeRequestSetReviewers(input: { projectPath: $projectPath, iid: $iid, operationMode: $operationMode, reviewerUsernames: $reviewerUsernames }) {
    errors
  }
}`;

export async function changeGitlabMergeRequestReviewers(
  input: unknown,
  context: PluginAccountActionContext,
): Promise<GitlabMergeRequestReviewerChangeResultV1> {
  const parsed = GitlabMergeRequestReviewerChangeInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  const request = parsed.data;
  const result = await runGitlabMemberDelta({
    instance: request.instance,
    localRef: request.localRef,
    routingToken: request.routingToken,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedHeadSha,
    operation: request.operation,
    selected: request.reviewerUsernames,
    members: (row) => row.reviewerUsernames,
    write: async (preflight) => requestGitlabJson({
      invocation: preflight.dependencies.invocation,
      url: buildGitlabGraphqlUrl(preflight.route.origin),
      method: 'POST',
      body: {
        query: DOCUMENT,
        variables: {
          projectPath: preflight.route.repositoryKey,
          iid: preflight.route.iid,
          operationMode: request.operation === 'add' ? 'APPEND' : 'REMOVE',
          reviewerUsernames: request.reviewerUsernames,
        },
      },
      fetcher: preflight.dependencies.fetcher,
      signal: preflight.dependencies.signal,
      nowMs: preflight.dependencies.nowMs,
    }),
    mutationErrors: (body) => readGitlabGraphqlMutationErrors(body, 'mergeRequestSetReviewers'),
  }, context);
  return result.kind === 'changed' ? { kind: 'reviewersChanged', item: result.item } : result;
}
