import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import { buildGitlabItemUrl } from '../detail/routes.js';
import { requestGitlabJson } from '../http/gitlabClient.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import {
  GitlabMergeRequestDiscussionResolutionInputV1Schema,
  type GitlabMergeRequestDiscussionResolutionResultV1,
} from './contracts.js';
import { GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1 } from './mergeRequestRow.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  GITLAB_MUTATION_INPUT_INVALID_FAILURE,
  preflightGitlabItemMutation,
} from './preflight.js';

const DISCUSSION_UNAVAILABLE_FAILURE: TriageSourceFailureV1 = Object.freeze({
  class: 'unsupportedContract',
  code: 'gitlab-discussion-unavailable',
});

function readDiscussion(value: unknown): Readonly<{ id: string; resolved: boolean; resolvable: boolean }> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Readonly<Record<string, unknown>>;
  return typeof row.id === 'string' && typeof row.resolved === 'boolean'
    ? { id: row.id, resolved: row.resolved, resolvable: row.resolvable === true }
    : null;
}

function discussionUrl(itemUrl: string, discussionId: string): string {
  return `${itemUrl}/discussions/${encodeURIComponent(discussionId)}`;
}

export async function resolveGitlabMergeRequestDiscussion(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabMergeRequestDiscussionResolutionResultV1> {
  const parsed = GitlabMergeRequestDiscussionResolutionInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  const request = parsed.data;
  const preflight = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedHeadSha,
  }, context);
  if (!preflight.ok) return preflight.refusal;

  const url = discussionUrl(buildGitlabItemUrl(preflight.route), request.discussionId);
  const beforeRead = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url,
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
  if (beforeRead.kind === 'failed') {
    return { kind: 'unavailable', failure: projectGitlabSourceFailure(beforeRead.failure) };
  }
  const before = readDiscussion(beforeRead.response.body);
  if (before === null || before.id !== request.discussionId) {
    return { kind: 'unavailable', failure: DISCUSSION_UNAVAILABLE_FAILURE };
  }
  if (before.resolved === request.resolved) {
    return {
      kind: 'discussionStateChanged',
      item: preflight.row,
      discussion: { id: before.id, resolved: before.resolved },
    };
  }
  if (!before.resolvable) {
    return { kind: 'unavailable', failure: DISCUSSION_UNAVAILABLE_FAILURE };
  }

  const write = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url,
    method: 'PUT',
    body: { resolved: request.resolved },
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
  if (write.kind === 'failed' && !gitlabWriteAnswerLost(write)) {
    return { kind: 'unavailable', failure: projectGitlabSourceFailure(write.failure) };
  }

  const afterRead = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url,
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });
  if (afterRead.kind === 'failed') {
    return { kind: 'unconfirmed', failure: projectGitlabSourceFailure(afterRead.failure) };
  }
  const after = readDiscussion(afterRead.response.body);
  if (after === null || after.id !== request.discussionId || after.resolved !== request.resolved) {
    return { kind: 'unconfirmed' };
  }
  const confirmedItem = await confirmGitlabItemMutation(preflight);
  if (!confirmedItem.ok) return { kind: 'unconfirmed', failure: confirmedItem.failure };
  if (confirmedItem.row.headSha !== request.observedHeadSha) {
    return { kind: 'unconfirmed', observed: confirmedItem.row };
  }
  return {
    kind: 'discussionStateChanged',
    item: confirmedItem.row,
    discussion: { id: after.id, resolved: after.resolved },
  };
}
