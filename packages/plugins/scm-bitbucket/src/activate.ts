import type {
  PluginApi,
} from '@happier-dev/plugin-sdk';

import { BITBUCKET_SCM_HOSTING_PROVIDER_ID } from './adapter.js';
import {
  BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
  materializeBitbucketScmHostingBasicAuth,
} from './auth/basicAuthMaterializer.js';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';

export function activate(api: PluginApi): void {
  api.registerScmHostingProvider({
    id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
    auth: {
      basicAuthMaterializer: {
        serviceId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
        materialize: materializeBitbucketScmHostingBasicAuth,
      },
    },
    adapter: bitbucketApiAdapter,
  });
}
