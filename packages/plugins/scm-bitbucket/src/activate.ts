import type { PluginApi } from '@happier-dev/plugin-sdk';

import { BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID } from './adapter.js';
import { bitbucketConnectedAccountRuntime } from './auth/connectedAccountRuntime.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';

export function activate(api: PluginApi): void {
  const hostingProvider = PLUGIN_MANIFEST.contributes.scmHostingProviders.find(
    ({ id }) => id === BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID,
  );
  const connectedAccountDescriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors.find(
    ({ id }) => id === hostingProvider?.authService,
  );
  if (!connectedAccountDescriptor) {
    throw new Error('Bitbucket plugin manifest must declare its connected-account auth service');
  }
  api.connectedAccounts.register(connectedAccountDescriptor.id, bitbucketConnectedAccountRuntime);
  api.scm.registerHostingProvider(BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID, {
    adapter: bitbucketApiAdapter,
  });
}
