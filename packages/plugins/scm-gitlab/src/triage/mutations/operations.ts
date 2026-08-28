/**
 * The bound GitLab mutation Actions.
 *
 * Each is its own exact Action with its own strict input, its own confirming
 * read and its own declared danger level. There is deliberately no shared
 * dispatcher here — re-exporting the six entry points is the whole file,
 * because a common `run` that branched on an operation name would be the
 * `mutate({ operation, payload })` envelope `sources/SCM.md` §3.8 rules out.
 *
 * The four state transitions DO share their write sequence, and share it at
 * `./stateTransition.js` rather than here: that module is consumed by each
 * Action's own handler, which is the opposite of a dispatcher a caller can
 * reach.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';

import { GITLAB_MUTATION_DEADLINE_MS } from '../admission.js';
import { withGitlabInvocationDeadline } from '../invocationDeadline.js';
import { mergeGitlabMergeRequest as mergeGitlabMergeRequestUnbounded } from './mergeRequestMerge.js';
import { markGitlabMergeRequestReady as markGitlabMergeRequestReadyUnbounded } from './mergeRequestDraft.js';
import {
  closeGitlabMergeRequest as closeGitlabMergeRequestUnbounded,
  reopenGitlabMergeRequest as reopenGitlabMergeRequestUnbounded,
} from './mergeRequestState.js';
import {
  closeGitlabIssue as closeGitlabIssueUnbounded,
  reopenGitlabIssue as reopenGitlabIssueUnbounded,
} from './issueState.js';
import { changeGitlabMergeRequestReviewers as changeGitlabMergeRequestReviewersUnbounded } from './reviewers.js';
import { resolveGitlabMergeRequestDiscussion as resolveGitlabMergeRequestDiscussionUnbounded } from './discussionResolution.js';
import { assignGitlabIssue as assignGitlabIssueUnbounded } from './issueAssignees.js';
import { changeGitlabIssueLabels as changeGitlabIssueLabelsUnbounded } from './issueLabels.js';
import {
  publishGitlabIssueComment as publishGitlabIssueCommentUnbounded,
  publishGitlabMergeRequestReview as publishGitlabMergeRequestReviewUnbounded,
  publishGitlabMergeRequestReviewComment as publishGitlabMergeRequestReviewCommentUnbounded,
  publishGitlabMergeRequestThreadReply as publishGitlabMergeRequestThreadReplyUnbounded,
} from './reviewPublication.js';

const boundMutation = <TInput, TResult>(
  run: (input: TInput, context: PluginInvocationContext) => Promise<TResult>,
) => withGitlabInvocationDeadline(GITLAB_MUTATION_DEADLINE_MS, run);

export const mergeGitlabMergeRequest = boundMutation(mergeGitlabMergeRequestUnbounded);
export const markGitlabMergeRequestReady = boundMutation(markGitlabMergeRequestReadyUnbounded);
export const closeGitlabMergeRequest = boundMutation(closeGitlabMergeRequestUnbounded);
export const reopenGitlabMergeRequest = boundMutation(reopenGitlabMergeRequestUnbounded);
export const closeGitlabIssue = boundMutation(closeGitlabIssueUnbounded);
export const reopenGitlabIssue = boundMutation(reopenGitlabIssueUnbounded);
export const changeGitlabMergeRequestReviewers = boundMutation(changeGitlabMergeRequestReviewersUnbounded);
export const resolveGitlabMergeRequestDiscussion = boundMutation(resolveGitlabMergeRequestDiscussionUnbounded);
export const assignGitlabIssue = boundMutation(assignGitlabIssueUnbounded);
export const changeGitlabIssueLabels = boundMutation(changeGitlabIssueLabelsUnbounded);
export const publishGitlabMergeRequestReview = boundMutation(publishGitlabMergeRequestReviewUnbounded);
export const publishGitlabMergeRequestReviewComment = boundMutation(
  publishGitlabMergeRequestReviewCommentUnbounded,
);
export const publishGitlabMergeRequestThreadReply = boundMutation(
  publishGitlabMergeRequestThreadReplyUnbounded,
);
export const publishGitlabIssueComment = boundMutation(publishGitlabIssueCommentUnbounded);
