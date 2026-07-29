import type { PluginApi } from '@happier-dev/plugin-sdk';

import { GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, gitlabHostingProviderAdapter } from './adapter.js';

export function activate(api: PluginApi): void {
  api.scm.registerHostingProvider(GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID, {
    adapter: gitlabHostingProviderAdapter,
  });
}
