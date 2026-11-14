import { createHostingProviderOperationActions } from '@happier-dev/plugin-sdk/scm/hosting';
import { bitbucketApiAdapter } from './operations/bitbucketApiAdapter.js';
import { BITBUCKET_HOSTING_OPERATION_ACTION_IDS_V1 } from './hostingActionIds.js';
import { BITBUCKET_PLUGIN_ID } from './bitbucketContracts.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from './triage/source/descriptor.js';
import { BITBUCKET_ACCOUNT_EXECUTION, READ_HOST_ACCESS } from './accountActions.js';

export const BITBUCKET_HOSTING_OPERATION_ACTIONS_V1: ReturnType<typeof createHostingProviderOperationActions<typeof BITBUCKET_HOSTING_OPERATION_ACTION_IDS_V1>> = createHostingProviderOperationActions({
  operationActions: BITBUCKET_HOSTING_OPERATION_ACTION_IDS_V1,
  adapter: { pullRequests: bitbucketApiAdapter, pullRequestCheckout: bitbucketApiAdapter, repositoryPublishing: bitbucketApiAdapter },
  purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
  service: { pluginId: BITBUCKET_PLUGIN_ID, localId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID },
  hostAccess: READ_HOST_ACCESS,
  execution: BITBUCKET_ACCOUNT_EXECUTION,
});
