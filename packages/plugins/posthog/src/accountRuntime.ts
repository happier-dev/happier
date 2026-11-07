import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { POSTHOG_ACCOUNT_ACTIONS } from './accountActions.js';
import { posthogPortableAccountRuntime } from './connect/account.js';
import { POSTHOG_CONNECTED_ACCOUNT_PURPOSE } from './posthogContracts.js';

/** Runs in the invoking Account host, including a credentialed daemon process. */
export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register(POSTHOG_CONNECTED_ACCOUNT_PURPOSE, posthogPortableAccountRuntime);
    for (const [id, action] of Object.entries(POSTHOG_ACCOUNT_ACTIONS)) {
        api.actions.register<JsonValue, JsonValue | void>(id, action.run);
    }
}
