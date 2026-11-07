import { azureDevopsPortableAuthentication } from './auth/azureDevopsConnectedAccountRuntime.js';
import { AZURE_DEVOPS_CONNECTED_ACCOUNT_ID } from './triage/descriptor.js';
import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { AZURE_DEVOPS_ACCOUNT_ACTIONS } from './accountActions.js';

/** The same finite handlers run in each admitted Account host. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(AZURE_DEVOPS_CONNECTED_ACCOUNT_ID, azureDevopsPortableAuthentication);
  for (const [id, action] of Object.entries(AZURE_DEVOPS_ACCOUNT_ACTIONS)) {
    api.actions.register<JsonValue, JsonValue | void>(id, action.run);
  }
}
