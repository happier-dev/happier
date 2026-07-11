import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { GITHUB_SCM_HOSTING_PROVIDER_ID } from './adapter.js';
import {
  GITHUB_CONNECTED_ACCOUNT_SERVICE_ID,
  materializeGithubScmHostingToken,
} from './auth/tokenMaterializer.js';
import { githubPullRequestAdapter } from './pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from './repositoryProvisioning/createRepositoryWithAuthFallback.js';

export function activate(api: PluginApi): void {
  api.registerScmHostingProvider({
    id: GITHUB_SCM_HOSTING_PROVIDER_ID,
    auth: {
      tokenMaterializer: {
        serviceId: GITHUB_CONNECTED_ACCOUNT_SERVICE_ID,
        materialize: materializeGithubScmHostingToken,
      },
    },
    adapter: Object.freeze({
      ...githubPullRequestAdapter,
      ...githubRepositoryProvisioningAdapter,
    }),
  });
}
