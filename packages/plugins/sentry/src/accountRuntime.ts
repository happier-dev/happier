import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { SENTRY_ACCOUNT_ACTIONS } from './accountActions.js';
import { sentryPortableAccountRuntime } from './auth/connectedAccountRuntime.js';
import { SENTRY_CONNECTED_ACCOUNT_ID } from './sentryContracts.js';

/** Runs in the invoking Account host, including a credentialed daemon process. */
export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register(SENTRY_CONNECTED_ACCOUNT_ID, sentryPortableAccountRuntime);
    for (const [id, action] of Object.entries(SENTRY_ACCOUNT_ACTIONS)) {
        api.actions.register<JsonValue, JsonValue | void>(id, action.run);
    }
}
