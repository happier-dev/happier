import type { JsonValue, PluginAccountApi } from '@happier-dev/plugin-sdk';
import { JIRA_ACCOUNT_ACTIONS } from './accountActions.js';
import { jiraPortableAccountRuntime } from './connect.js';
import { JIRA_ACCOUNT_PURPOSE } from './contracts.js';

/** Runs in the invoking Account host, including a credentialed daemon process. */
export function activate(api: PluginAccountApi): void {
    api.connectedAccounts.register(JIRA_ACCOUNT_PURPOSE, jiraPortableAccountRuntime);
    for (const [id, action] of Object.entries(JIRA_ACCOUNT_ACTIONS)) {
        api.actions.register<JsonValue, JsonValue | void>(id, action.run);
    }
}
