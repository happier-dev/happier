import type { PluginDisposable } from '@happier-dev/plugin-sdk';

import {
  AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID,
  azureDevopsHostingProviderAdapter,
} from './detection/adapter.js';

type ScmHostingProviderActivationApi = Readonly<{
  registerScmHostingProvider(registration: Readonly<{
    id: string;
    adapter: Readonly<Record<string, unknown>>;
  }>): PluginDisposable;
}>;

export function activate(api: ScmHostingProviderActivationApi): void {
  api.registerScmHostingProvider({
    id: AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID,
    adapter: azureDevopsHostingProviderAdapter,
  });
}
