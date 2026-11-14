import type { HostingProviderContribution } from '@happier-dev/plugin-sdk/scm/hosting';

/** Existing Bitbucket remote methods; local Git operations remain on the requester. */
export const BITBUCKET_HOSTING_OPERATION_ACTION_IDS_V1 = {
  listPullRequests: 'bitbucket/hosting/pull-requests-list',
  getPullRequest: 'bitbucket/hosting/pull-request-get',
  createPullRequest: 'bitbucket/hosting/pull-request-create',
  resolvePullRequestCheckoutReference: 'bitbucket/hosting/pull-request-checkout-reference',
  describePublishTargets: 'bitbucket/hosting/publish-targets-describe',
  createRepository: 'bitbucket/hosting/repository-create',
  getRepository: 'bitbucket/hosting/repository-get',
} as const satisfies NonNullable<HostingProviderContribution['operationActions']>;
