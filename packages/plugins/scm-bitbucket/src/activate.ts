import type { PluginDisposable } from '@happier-dev/plugin-sdk';

import { BITBUCKET_SCM_HOSTING_PROVIDER_ID, bitbucketHostingProviderAdapter } from './adapter.js';

type ScmHostingProviderActivationApi = Readonly<{
  registerScmHostingProvider(registration: Readonly<{
    id: string;
    adapter: Readonly<Record<string, unknown>>;
  }>): PluginDisposable;
}>;

export function activate(api: ScmHostingProviderActivationApi): void {
  api.registerScmHostingProvider({
    id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
    adapter: bitbucketHostingProviderAdapter,
  });
}
