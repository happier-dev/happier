/**
 * `gitlab/merge-request/merge`.
 *
 * Three facts from `sources/SCM.md` §4.7.2 shape this whole module, and each of
 * them independently breaks a synchronous mental model:
 *
 * 1. **A 200 is not a merge.** `auto_merge` and merge trains mean GitLab may
 *    schedule the merge instead of performing it, so terminal success is a
 *    re-read showing `merged` — never the merge call's status code.
 * 2. **The documented failure codes are distinct outcomes**, not one error:
 *    `405` cannot-merge, `409` our head pin lost the race, `422` the merge ran
 *    and failed and is not retryable without a human.
 * 3. **Mergeability is a cached, asynchronously recomputed projection.**
 *    `checking`, `approvals_syncing` and `ci_still_running` are unknown-retry.
 *    This Action therefore never preflights on `detailed_merge_status`: doing so
 *    would refuse a merge GitLab would have performed.
 *
 * The head pin is sent as GitLab's own `sha` precondition, so the compare
 * happens at the provider rather than in this process.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { buildGitlabMergeRequestMergeUrl } from '../detail/routes.js';
import { requestGitlabJson } from '../http/gitlabClient.js';
import { projectGitlabSourceFailure } from '../sourceFailure.js';
import {
  GitlabMergeRequestMergeInputV1Schema,
  type GitlabMergeRequestMergeResultV1,
} from './contracts.js';
import { GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1 } from './mergeRequestRow.js';
import {
  confirmGitlabItemMutation,
  gitlabWriteAnswerLost,
  preflightGitlabItemMutation,
  GITLAB_MUTATION_INPUT_INVALID_FAILURE,
} from './preflight.js';

/** GitLab's own documented merge failures, each answering a different question. */
const MERGE_REFUSAL_BY_STATUS: Readonly<Record<number, 'shaRequired' | 'notMergeable' | 'headAdvanced' | 'mergeAttemptFailed'>> = Object.freeze({
  400: 'shaRequired',
  405: 'notMergeable',
  409: 'headAdvanced',
  422: 'mergeAttemptFailed',
});

export async function mergeGitlabMergeRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabMergeRequestMergeResultV1> {
  const parsed = GitlabMergeRequestMergeInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }
  const request = parsed.data;

  const preflight = await preflightGitlabItemMutation({
    instance: request.instance,
    localRef: request.localRef,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    expectedRevision: request.observedHeadSha,
  }, context);
  if (!preflight.ok) return preflight.refusal;

  // Already merged: the transition converges rather than creating a second
  // object, so the exact requested outcome is reported without a second write.
  if (preflight.row.state === 'merged' || preflight.row.mergedAtMs !== undefined) {
    return { kind: 'merged', item: preflight.row };
  }
  if (preflight.row.state !== 'opened') {
    return {
      kind: 'refused',
      reason: 'notOpen',
      dispatched: false,
      observed: preflight.row,
    };
  }

  const write = await requestGitlabJson({
    invocation: preflight.dependencies.invocation,
    url: buildGitlabMergeRequestMergeUrl(preflight.route),
    method: 'PUT',
    // GitLab's own conditional write. `sha` must match the head of the source
    // branch or GitLab refuses with `409` — which is exactly the answer the user
    // is owed when their read went stale.
    body: { sha: request.observedHeadSha },
    fetcher: preflight.dependencies.fetcher,
    signal: preflight.dependencies.signal,
    nowMs: preflight.dependencies.nowMs,
  });

  if (write.kind === 'failed') {
    const reason = write.status === undefined ? undefined : MERGE_REFUSAL_BY_STATUS[write.status];
    if (reason !== undefined) {
      // One confirming read, never a retry: `422` means the merge ran and failed,
      // and `409` means the user must re-decide against the head they now have.
      const observed = await confirmGitlabItemMutation(preflight);
      return {
        kind: 'refused',
        reason,
        dispatched: true,
        ...(observed.ok ? { observed: observed.row } : {}),
      };
    }
    if (!gitlabWriteAnswerLost(write)) {
      // GitLab answered, and the answer was not one of its documented merge
      // outcomes — a denial, a rate-limit refusal, or a server error. It is
      // reported as it came rather than reinterpreted: a user who retries runs
      // the preflight again, which converges on an already-merged item without
      // a second write.
      return { kind: 'unavailable', failure: projectGitlabSourceFailure(write.failure) };
    }
    // The request left this process and no answer came back, so GitLab may have
    // merged. It falls through to exactly the confirming read a `200` gets —
    // reporting `unavailable` here would tell a user nothing was attempted about
    // a merge that landed, and a second PUT would re-decide on their behalf.
  }

  const confirmed = await confirmGitlabItemMutation(preflight);
  if (!confirmed.ok) {
    // The write left this process and its outcome is unproven. Reporting it as a
    // plain failure would tell the user nothing happened to a merge that may
    // have landed in production.
    return { kind: 'unconfirmed', failure: confirmed.failure };
  }
  if (confirmed.row.state === 'merged' || confirmed.row.mergedAtMs !== undefined) {
    return { kind: 'merged', item: confirmed.row };
  }
  if (confirmed.row.autoMergeScheduled) {
    return { kind: 'scheduled', item: confirmed.row };
  }
  return { kind: 'unconfirmed', observed: confirmed.row };
}
