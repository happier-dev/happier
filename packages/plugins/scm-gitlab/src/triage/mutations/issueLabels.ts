import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { buildGitlabItemUrl } from '../detail/routes.js';
import { requestGitlabJson } from '../http/gitlabClient.js';
import {
  GitlabIssueLabelInputV1Schema,
  type GitlabIssueLabelResultV1,
} from './contracts.js';
import { GITLAB_ISSUE_MUTATION_SUBJECT_V1 } from './issueRow.js';
import { runGitlabMemberDelta } from './memberDelta.js';
import { GITLAB_MUTATION_INPUT_INVALID_FAILURE } from './preflight.js';

export async function changeGitlabIssueLabels(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabIssueLabelResultV1> {
  const parsed = GitlabIssueLabelInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  const request = parsed.data;
  const result = await runGitlabMemberDelta({
    instance: request.instance,
    localRef: request.localRef,
    subject: GITLAB_ISSUE_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedRevision,
    operation: request.operation,
    selected: request.labelNames,
    members: (row) => row.labelNames,
    write: (preflight) => requestGitlabJson({
      invocation: preflight.dependencies.invocation,
      url: buildGitlabItemUrl(preflight.route),
      method: 'PUT',
      body: request.operation === 'add'
        ? { add_labels: request.labelNames.join(',') }
        : { remove_labels: request.labelNames.join(',') },
      fetcher: preflight.dependencies.fetcher,
      signal: preflight.dependencies.signal,
      nowMs: preflight.dependencies.nowMs,
    }),
  }, context);
  return result.kind === 'changed' ? { kind: 'labelsChanged', item: result.item } : result;
}
