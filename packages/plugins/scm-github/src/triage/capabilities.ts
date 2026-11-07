import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import type { GithubRepositoryMergeSettingsV1, GithubRepositoryReadV1 } from './repositories.js';
import type { GithubTriageKindIdV1 } from './types.js';
import type { GithubMergeMethodV1 } from './mutations/contracts.js';
import type { GithubCapabilityAvailabilityV1 } from './detail/contracts.js';

export type { GithubCapabilityAvailabilityV1 } from './detail/contracts.js';

export type GithubRepositoryCapabilitiesV1 = Readonly<{
  operations: Readonly<Partial<Record<keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, GithubCapabilityAvailabilityV1>>>;
  mergeMethods: Readonly<Record<GithubMergeMethodV1, GithubCapabilityAvailabilityV1>>;
  /** Native settings; absent on an older result, null when GitHub did not state one. */
  mergeSettings?: GithubRepositoryMergeSettingsV1;
}>;

const available = Object.freeze({ kind: 'available' as const });
const unsupported = Object.freeze({ kind: 'unavailable' as const, code: 'repository_unsupported' as const });
const archived = Object.freeze({ kind: 'denied' as const, code: 'repository_archived' as const });

export function projectGithubRepositoryCapabilities(
  repository: Extract<GithubRepositoryReadV1, { kind: 'readable' }>,
  entryKind: GithubTriageKindIdV1 = 'issue',
): GithubRepositoryCapabilitiesV1 & Readonly<{
  operations: Readonly<Record<keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, GithubCapabilityAvailabilityV1>>;
}> {
  const allArchived = repository.archived === true;
  // Repository roles are deliberately absent here. They are coarse repository
  // facts, not authoritative preflights for comment, review, state, reviewer,
  // branch, or merge operations. When GitHub exposes no decisive negative fact,
  // the confirmed Action remains the permission owner.
  const operation = (issue: boolean): GithubCapabilityAvailabilityV1 => allArchived
    ? archived
    : issue && repository.hasIssues === false ? unsupported : available;
  const operations = Object.freeze({
    pullRequestPreviewStatus: operation(false),
    closingReferenceAdd: operation(true),
    closingReferenceRemove: operation(true),
    subIssueAdd: operation(true),
    subIssueRemove: operation(true),
    subIssueReprioritize: operation(true),
    blockedByAdd: operation(true),
    blockedByRemove: operation(true),
    blockingAdd: operation(true),
    blockingRemove: operation(true),
    projectItemAdd: operation(false),
    projectItemRemove: operation(false),
    projectFieldSet: operation(false),
    projectFieldClear: operation(false),
    pullRequestEdit: operation(false),
    pullRequestChangeBase: operation(false),
    pullRequestConvertToDraft: operation(false),
    entryMilestoneSet: operation(false),
    issueTypeSet: operation(true),
    entryLock: operation(false),
    entryUnlock: operation(false),
    pendingReviewCreate: operation(false),
    pendingReviewSubmit: operation(false),
    pendingReviewDelete: operation(false),
    reviewDismiss: operation(false),
    issueTransfer: operation(true),
    issueDelete: operation(true),
    issuePin: operation(true),
    issueUnpin: operation(true),
    entrySubscribe: operation(false),
    entryUnsubscribe: operation(false),
    pullRequestRevert: operation(false),
    pullRequestHeadBranchRestore: operation(false),
    pullRequestHeadBranchDelete: operation(false),
    pullRequestMerge: operation(false),
    pullRequestEnqueue: operation(false),
    pullRequestDequeue: operation(false),
    pullRequestAutoMergeSet: operation(false),
    pullRequestSubmitReview: operation(false),
    pullRequestReviewCommentCreate: operation(false),
    pullRequestThreadReply: operation(false),
    pullRequestClose: operation(false),
    pullRequestReopen: operation(false),
    pullRequestMarkReady: operation(false),
    pullRequestUpdateBranch: operation(false),
    pullRequestAddReviewers: operation(false),
    pullRequestRemoveReviewers: operation(false),
    pullRequestThreadResolution: operation(false),
    issueClose: operation(true),
    issueReopen: operation(true),
    issueComment: operation(true),
    issueAssigneeAdd: operation(entryKind !== 'pull-request'),
    issueAssigneeRemove: operation(entryKind !== 'pull-request'),
    issueLabelAdd: operation(entryKind !== 'pull-request'),
    issueLabelRemove: operation(entryKind !== 'pull-request'),
    // Who may edit is GitHub's per-comment `viewerCanUpdate`; this states only the archive.
    commentEdit: operation(false),
    commentCreate: operation(false),
  } satisfies Record<keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, GithubCapabilityAvailabilityV1>);
  const mergeMethod = (setting: boolean | null): GithubCapabilityAvailabilityV1 => {
    if (allArchived) return archived;
    return setting === false ? unsupported : available;
  };
  return Object.freeze({
    operations,
    mergeSettings: repository.mergeSettings,
    mergeMethods: Object.freeze({
      merge: mergeMethod(repository.mergeSettings.merge),
      squash: mergeMethod(repository.mergeSettings.squash),
      rebase: mergeMethod(repository.mergeSettings.rebase),
    }),
  });
}
