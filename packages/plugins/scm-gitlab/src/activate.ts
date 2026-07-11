import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { GITLAB_SCM_HOSTING_PROVIDER_ID, gitlabHostingProviderAdapter } from './adapter.js';

export function activate(api: PluginApi): void {
  api.registerScmHostingProvider({
    id: GITLAB_SCM_HOSTING_PROVIDER_ID,
    adapter: gitlabHostingProviderAdapter,
  });
}
