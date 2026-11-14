import { GITLAB_HOSTING_OPERATION_ACTIONS_V1 } from './hostingActions.js';
import { gitlabPortableAuthentication } from './auth/connectedAccountRuntime.js';
import { GITLAB_CONNECTED_ACCOUNT_ID } from './triage/contribution.js';
import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { GITLAB_ACCOUNT_ACTIONS } from './accountActions.js';

/** The same finite handlers run in each admitted Account host. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(GITLAB_CONNECTED_ACCOUNT_ID, gitlabPortableAuthentication);
  for (const [id, action] of Object.entries(GITLAB_HOSTING_OPERATION_ACTIONS_V1)) {
    api.actions.register(id, (input, context) => action.run!(input, context));
  }
  for (const [id, action] of Object.entries(GITLAB_ACCOUNT_ACTIONS)) {
    api.actions.register<JsonValue, JsonValue | void>(id, action.run);
  }
}
