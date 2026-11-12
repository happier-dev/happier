import type { HostingProviderContribution } from '@happier-dev/plugin-sdk/scm/hosting';

/** Exact remote methods; local repository work is never part of these Actions. */
export const GITHUB_HOSTING_OPERATION_ACTION_IDS_V1 = {
  listPullRequests: 'github/hosting/pull-requests-list',
  getPullRequest: 'github/hosting/pull-request-get',
  createPullRequest: 'github/hosting/pull-request-create',
  resolvePullRequestCheckoutReference: 'github/hosting/pull-request-checkout-reference',
  describePublishTargets: 'github/hosting/publish-targets-describe',
  createRepository: 'github/hosting/repository-create',
  getRepository: 'github/hosting/repository-get',
  describeCloneTargets: 'github/hosting/clone-targets-describe',
} as const satisfies NonNullable<HostingProviderContribution['operationActions']>;
