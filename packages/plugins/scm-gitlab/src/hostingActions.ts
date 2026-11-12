import type { PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { createHostingProviderOperationActions } from '@happier-dev/plugin-sdk/scm/hosting';
import { gitlabRestPullRequestAdapter } from './pullRequests/index.js';
import { GITLAB_HOSTING_OPERATION_ACTION_IDS_V1 } from './hostingActionIds.js';
import { GITLAB_ACCOUNT_EXECUTION, GITLAB_CONNECTED_ACCOUNT_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID, GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID, GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID } from './triage/contribution.js';

export const GITLAB_HOSTING_OPERATION_ACTIONS_V1: Readonly<Record<
  (typeof GITLAB_HOSTING_OPERATION_ACTION_IDS_V1)[keyof typeof GITLAB_HOSTING_OPERATION_ACTION_IDS_V1],
  PluginActionDefinition<Extract<PluginActionDeclaration, Readonly<{ execution: Readonly<{ target: 'account' }> }>>>
>> = createHostingProviderOperationActions({
  operationActions: GITLAB_HOSTING_OPERATION_ACTION_IDS_V1,
  adapter: { pullRequests: gitlabRestPullRequestAdapter },
  purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  service: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_CONNECTED_ACCOUNT_ID },
  hostAccess: [GITLAB_ACCOUNT_NETWORK_HOST_ACCESS_ID, GITLAB_CLOUD_NETWORK_HOST_ACCESS_ID, GITLAB_CONNECTED_ACCOUNT_PURPOSE],
  execution: GITLAB_ACCOUNT_EXECUTION,
});
