import type { PluginApiV1 } from '@happier-dev/plugin-sdk';

import { GITHUB_SCM_HOSTING_PROVIDER_ID } from './adapter.js';
import { githubPullRequestAdapter } from './pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from './repositoryProvisioning/createRepositoryWithAuthFallback.js';

export function activate(api: PluginApiV1): void {
  api.registerScmHostingProvider({
    id: GITHUB_SCM_HOSTING_PROVIDER_ID,
    adapter: Object.freeze({
      ...githubPullRequestAdapter,
      ...githubRepositoryProvisioningAdapter,
    }),
  });
}
