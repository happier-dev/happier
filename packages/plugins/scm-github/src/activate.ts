import type { PluginApi } from '@happier-dev/plugin-sdk';

import { GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID } from './adapter.js';
import { githubConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { githubPullRequestAdapter } from './pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from './repositoryProvisioning/createRepositoryWithAuthFallback.js';

export function activate(api: PluginApi): void {
  const connectedAccountDescriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === PLUGIN_MANIFEST.contributes.scmHostingProviders[0]?.authService,
  );
  if (!connectedAccountDescriptor) {
    throw new Error('GitHub plugin manifest must declare its connected-account auth service');
  }
  api.connectedAccounts.register(connectedAccountDescriptor.id, githubConnectedAccountRuntime);
  api.scm.registerHostingProvider(GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID, {
    adapter: Object.freeze({
      ...githubPullRequestAdapter,
      ...githubRepositoryProvisioningAdapter,
    }),
  });
}
