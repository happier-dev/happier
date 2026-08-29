import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import type { GithubRepositoryReadV1 } from './repositories.js';

export type GithubCapabilityAvailabilityV1 =
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'unavailable'; code: 'repository_unsupported' }>
  | Readonly<{ kind: 'denied'; code: 'repository_archived' }>;

export type GithubRepositoryCapabilitiesV1 = Readonly<{
  operations: Readonly<Record<keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, GithubCapabilityAvailabilityV1>>;
  mergeMethods: Readonly<Record<'merge' | 'squash' | 'rebase', GithubCapabilityAvailabilityV1>>;
}>;

const available = Object.freeze({ kind: 'available' as const });
const unsupported = Object.freeze({ kind: 'unavailable' as const, code: 'repository_unsupported' as const });
const archived = Object.freeze({ kind: 'denied' as const, code: 'repository_archived' as const });

export function projectGithubRepositoryCapabilities(
  repository: Extract<GithubRepositoryReadV1, { kind: 'readable' }>,
): GithubRepositoryCapabilitiesV1 {
  const allArchived = repository.archived === true;
  // Repository roles are deliberately absent here. They are coarse repository
  // facts, not authoritative preflights for comment, review, state, reviewer,
  // branch, or merge operations. When GitHub exposes no decisive negative fact,
  // the confirmed Action remains the permission owner.
  const operation = (issue: boolean): GithubCapabilityAvailabilityV1 => allArchived
    ? archived
    : issue && repository.hasIssues === false ? unsupported : available;
  const operations = Object.freeze({
    pullRequestMerge: operation(false),
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
    issueAssigneeAdd: operation(true),
    issueAssigneeRemove: operation(true),
    issueLabelAdd: operation(true),
    issueLabelRemove: operation(true),
  });
  const mergeMethod = (setting: boolean | null): GithubCapabilityAvailabilityV1 => {
    if (allArchived) return archived;
    return setting === false ? unsupported : available;
  };
  return Object.freeze({
    operations,
    mergeMethods: Object.freeze({
      merge: mergeMethod(repository.mergeSettings.merge),
      squash: mergeMethod(repository.mergeSettings.squash),
      rebase: mergeMethod(repository.mergeSettings.rebase),
    }),
  });
}
