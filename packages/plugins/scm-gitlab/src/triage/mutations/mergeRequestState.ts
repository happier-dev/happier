/**
 * `gitlab/merge-request/close` and `gitlab/merge-request/reopen`.
 *
 * **Neither carries a pin** (`sources/SCM.md` §2.6, and §3.8's reopen row): both
 * transitions are head-independent, and carrying a pin would add a failure mode
 * that protects no invariant — a collaborator's push would refuse a close that
 * nothing invalidated. §2.8's fresh read still runs before any effect, and the
 * gate it feeds is the one each transition actually asks: GitLab must still
 * report the state that transition runs FROM.
 *
 * The write sequence itself lives in `./stateTransition.js`, which all four
 * GitLab state Actions share. What is stated here is only what is
 * merge-request-specific: which state each transition converges on, which state
 * it refuses from and why, and what its confirming read must prove.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import {
  GitlabMergeRequestCloseInputV1Schema,
  GitlabMergeRequestReopenInputV1Schema,
  type GitlabMergeRequestCloseResultV1,
  type GitlabMergeRequestReopenResultV1,
  type GitlabMergeRequestStateRowV1,
} from './contracts.js';
import { GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1 } from './mergeRequestRow.js';
import { GITLAB_MUTATION_INPUT_INVALID_FAILURE } from './preflight.js';
import { runGitlabStateTransition, type GitlabStateTransitionV1 } from './stateTransition.js';

const CLOSE_TRANSITION: GitlabStateTransitionV1<GitlabMergeRequestStateRowV1> = Object.freeze({
  stateEvent: 'close',
  converged: (row) => row.state === 'closed',
  // A merged merge request has no close transition, and asking for one would be
  // a request the user cannot act on.
  blocked: (row) => row.state === 'opened' ? null : { reason: 'notOpen' },
  proven: (row) => row.state === 'closed',
});

const REOPEN_TRANSITION: GitlabStateTransitionV1<GitlabMergeRequestStateRowV1> = Object.freeze({
  stateEvent: 'reopen',
  converged: (row) => row.state === 'opened',
  blocked: (row) => {
    // Merged is terminal: GitLab has no reopen transition for it at all. That is
    // different advice from "not currently closed" — one may change on the next
    // read and the other never will — so it is reported as its own reason rather
    // than collapsed into one word meaning "try again later".
    if (row.state === 'merged' || row.mergedAtMs !== undefined) {
      return { reason: 'notReopenable' };
    }
    return row.state === 'closed' ? null : { reason: 'notOpen' };
  },
  proven: (row) => row.state === 'opened',
});

export async function closeGitlabMergeRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabMergeRequestCloseResultV1> {
  const parsed = GitlabMergeRequestCloseInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }

  const outcome = await runGitlabStateTransition({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    transition: CLOSE_TRANSITION,
  }, context);

  return outcome.kind === 'applied' ? { kind: 'closed', item: outcome.item } : outcome;
}

export async function reopenGitlabMergeRequest(
  input: unknown,
  context: PluginInvocationContext,
): Promise<GitlabMergeRequestReopenResultV1> {
  const parsed = GitlabMergeRequestReopenInputV1Schema.safeParse(input);
  if (!parsed.success) {
    return { kind: 'unavailable', failure: GITLAB_MUTATION_INPUT_INVALID_FAILURE };
  }

  const outcome = await runGitlabStateTransition({
    instance: parsed.data.instance,
    localRef: parsed.data.localRef,
    subject: GITLAB_MERGE_REQUEST_MUTATION_SUBJECT_V1,
    transition: REOPEN_TRANSITION,
  }, context);

  return outcome.kind === 'applied' ? { kind: 'reopened', item: outcome.item } : outcome;
}
