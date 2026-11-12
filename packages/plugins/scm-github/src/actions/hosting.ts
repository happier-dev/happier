import type { PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { createHostingProviderOperationActions } from '@happier-dev/plugin-sdk/scm/hosting';
import { githubPullRequestAdapter } from '../pullRequests/authChain.js';
import { githubRepositoryProvisioningAdapter } from '../repositoryProvisioning/createRepositoryWithAuthFallback.js';
import { GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_ACCOUNT_EXECUTION, TRIAGE_READ_HOST_ACCESS } from '../triage/readActions.js';
import { GITHUB_HOSTING_OPERATION_ACTION_IDS_V1 } from './hostingActionIds.js';

export const GITHUB_HOSTING_OPERATION_ACTIONS_V1: Readonly<Record<
  (typeof GITHUB_HOSTING_OPERATION_ACTION_IDS_V1)[keyof typeof GITHUB_HOSTING_OPERATION_ACTION_IDS_V1],
  PluginActionDefinition<Extract<PluginActionDeclaration, Readonly<{ execution: Readonly<{ target: 'account' }> }>>>
>> = createHostingProviderOperationActions({
  operationActions: GITHUB_HOSTING_OPERATION_ACTION_IDS_V1,
  adapter: { pullRequests: githubPullRequestAdapter, pullRequestCheckout: githubPullRequestAdapter,
    repositoryPublishing: githubRepositoryProvisioningAdapter, repositoryClone: githubRepositoryProvisioningAdapter },
  purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  service: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_CONNECTED_ACCOUNT_ID },
  hostAccess: TRIAGE_READ_HOST_ACCESS,
  execution: GITHUB_ACCOUNT_EXECUTION,
});
