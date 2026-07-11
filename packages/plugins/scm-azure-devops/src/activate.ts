import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import {
  AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID,
} from './detection/adapter.js';
import { azureDevopsOperationsAdapter } from './operations/azureDevopsAdapter.js';

export function activate(api: PluginApi): void {
  api.registerScmHostingProvider({
    id: AZURE_DEVOPS_SCM_HOSTING_PROVIDER_ID,
    adapter: azureDevopsOperationsAdapter,
  });
}
