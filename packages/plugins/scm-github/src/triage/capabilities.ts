import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from './contribution.js';
import type { GithubRepositoryReadV1 } from './repositories.js';
import type { GithubTriageKindIdV1 } from './types.js';

export type GithubCapabilityAvailabilityV1 =
  | Readonly<{ kind: 'available' }>
  | Readonly<{ kind: 'unavailable'; code: 'api_not_exposed' | 'repository_unsupported' }>
  | Readonly<{ kind: 'denied'; code: 'repository_archived' | 'forbidden_by_forge' }>;

export type GithubRepositoryCapabilitiesV1 = Readonly<{
  operations: Readonly<Record<keyof typeof GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1, GithubCapabilityAvailabilityV1>>;
  mergeMethods: Readonly<Record<'merge' | 'squash' | 'rebase', GithubCapabilityAvailabilityV1>>;
}>;

const available = Object.freeze({ kind: 'available' as const });
const unknown = Object.freeze({ kind: 'unavailable' as const, code: 'api_not_exposed' as const });
const unsupported = Object.freeze({ kind: 'unavailable' as const, code: 'repository_unsupported' as const });
const archived = Object.freeze({ kind: 'denied' as const, code: 'repository_archived' as const });
const forbidden = Object.freeze({ kind: 'denied' as const, code: 'forbidden_by_forge' as const });

function authority(values: readonly (boolean | null)[]): GithubCapabilityAvailabilityV1 {
  if (values.includes(true)) return available;
  return values.every((value) => value === false) ? forbidden : unknown;
}

export function projectGithubRepositoryCapabilities(
  repository: Extract<GithubRepositoryReadV1, { kind: 'readable' }>,
  kindId: GithubTriageKindIdV1,
): GithubRepositoryCapabilitiesV1 {
  void kindId;
  const repositoryWrite = authority([
    repository.viewerPermissions.admin,
    repository.viewerPermissions.maintain,
    repository.viewerPermissions.push,
  ]);
  const issueWrite = authority([
    repository.viewerPermissions.admin,
    repository.viewerPermissions.maintain,
    repository.viewerPermissions.push,
    repository.viewerPermissions.triage,
  ]);
  const issueAvailability = repository.hasIssues === true
    ? issueWrite
    : repository.hasIssues === false ? unsupported : unknown;
  const allArchived = repository.archived === true;
  const operation = (issue: boolean): GithubCapabilityAvailabilityV1 =>
    allArchived ? archived : repository.archived === null
      ? unknown : issue ? issueAvailability : repositoryWrite;
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
    if (repository.archived === null) return unknown;
    if (repositoryWrite.kind !== 'available') return repositoryWrite;
    return setting === true ? available : setting === false ? unsupported : unknown;
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
