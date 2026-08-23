/**
 * The six bound GitLab mutation Actions.
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

export { mergeGitlabMergeRequest } from './mergeRequestMerge.js';
export { markGitlabMergeRequestReady } from './mergeRequestDraft.js';
export { closeGitlabMergeRequest, reopenGitlabMergeRequest } from './mergeRequestState.js';
export { closeGitlabIssue, reopenGitlabIssue } from './issueState.js';
