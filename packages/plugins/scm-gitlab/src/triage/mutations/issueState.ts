/**
 * `gitlab/issue/close` and `gitlab/issue/reopen`.
 *
 * `sources/SCM.md` §4.7: GitLab expresses both as `state_event` on
 * `PUT /projects/{id}/issues/{iid}`, and every issue Action carries the
 * user-observed `nativeRevision` — GitLab's own `updated_at`. An issue has no
 * head commit, so that byte IS the currentness gate: a changed revision returns
 * a typed reconfirmation with **zero** writes rather than acting on a read the
 * user never saw.
 *
 * The route is the load-bearing detail these two share with nothing else in this
 * package. A GitLab issue `#42` and a GitLab merge request `!42` can live in one
 * project, so an Action that reached `…/merge_requests/{iid}` for an issue
 * reference would transition a completely different item — and every assertion
 * about the response would still look right. The kind is therefore refused at
 * admission, by the shared preflight, from the subject descriptor these Actions
 * name; there is no route branch here to get wrong.
 *
 * The write sequence lives in `./stateTransition.js`, shared with the two
 * merge-request state Actions.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import {
  GitlabIssueCloseInputV1Schema,
  GitlabIssueReopenInputV1Schema,
  type GitlabIssueCloseResultV1,
  type GitlabIssueReopenResultV1,
  type GitlabIssueStateRowV1,
} from './contracts.js';
import { GITLAB_ISSUE_MUTATION_SUBJECT_V1 } from './issueRow.js';
import { GITLAB_MUTATION_INPUT_INVALID_FAILURE } from './preflight.js';
import { runGitlabStateTransition, type GitlabStateTransitionV1 } from './stateTransition.js';

const CLOSE_TRANSITION: GitlabStateTransitionV1<GitlabIssueStateRowV1> = Object.freeze({
  stateEvent: 'close',
  converged: (row) => row.state === 'closed',
  // GitLab's issue states are `opened` and `closed`. Anything else is a word this
  // build has not heard of, and transitioning from a state it cannot name would
  // be acting on a guess.
  blocked: (row) => row.state === 'opened' ? null : { reason: 'notOpen' },
  proven: (row) => row.state === 'closed',
});

const REOPEN_TRANSITION: GitlabStateTransitionV1<GitlabIssueStateRowV1> = Object.freeze({
  stateEvent: 'reopen',
  converged: (row) => row.state === 'opened',
  blocked: (row) => row.state === 'closed' ? null : { reason: 'notOpen' },
  proven: (row) => row.state === 'opened',
});

export async function closeGitlabIssue(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabIssueCloseResultV1> {
  const parsed = GitlabIssueCloseInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }

  const outcome = await runGitlabStateTransition({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
    subject: GITLAB_ISSUE_MUTATION_SUBJECT_V1,
    expectedRevision: parsed.data.observedRevision,
    transition: CLOSE_TRANSITION,
  }, context);

  return outcome.kind === 'applied' ? { kind: 'closed', item: outcome.item } : outcome;
}

export async function reopenGitlabIssue(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabIssueReopenResultV1> {
  const parsed = GitlabIssueReopenInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }

  const outcome = await runGitlabStateTransition({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
    subject: GITLAB_ISSUE_MUTATION_SUBJECT_V1,
    expectedRevision: parsed.data.observedRevision,
    transition: REOPEN_TRANSITION,
  }, context);

  return outcome.kind === 'applied' ? { kind: 'reopened', item: outcome.item } : outcome;
}
