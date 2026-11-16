import type { HostingProviderContribution } from '@happier-dev/plugin-sdk/scm/hosting';

export const GITLAB_HOSTING_OPERATION_ACTION_IDS_V1 = {
  describePublishTargets: 'gitlab/hosting/publish-targets-describe',
  createRepository: 'gitlab/hosting/repository-create',
  getRepository: 'gitlab/hosting/repository-get',
  listPullRequests: 'gitlab/hosting/merge-requests-list',
  getPullRequest: 'gitlab/hosting/merge-request-get',
  createPullRequest: 'gitlab/hosting/merge-request-create',
} as const satisfies NonNullable<HostingProviderContribution['operationActions']>;
