import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { LINEAR_ACCOUNT_ACTIONS } from './accountActions.js';
import { linearPortableAccountRuntime } from './account.js';
import { LINEAR_SERVICE_ID } from './contracts.js';

/** Runs in the invoking Account host, including a credentialed daemon process. */
export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register(LINEAR_SERVICE_ID, linearPortableAccountRuntime);
    for (const [id, action] of Object.entries(LINEAR_ACCOUNT_ACTIONS)) {
        api.actions.register<JsonValue, JsonValue | void>(id, action.run);
    }
}
