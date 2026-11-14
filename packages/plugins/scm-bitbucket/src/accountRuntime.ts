import { bitbucketPortableAuthentication } from './auth/connectedAccountRuntime.js';
import { BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID } from './triage/source/descriptor.js';
import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { BITBUCKET_ACCOUNT_ACTIONS } from './accountActions.js';
import { BITBUCKET_HOSTING_OPERATION_ACTIONS_V1 } from './hostingActions.js';

/** The same finite handlers run in each admitted Account host. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID, bitbucketPortableAuthentication);
  for (const [id, action] of Object.entries({ ...BITBUCKET_ACCOUNT_ACTIONS, ...BITBUCKET_HOSTING_OPERATION_ACTIONS_V1 })) {
    api.actions.register<JsonValue, JsonValue | void>(id, action.run);
  }
}
