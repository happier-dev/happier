import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { claudeSubscriptionConnectedAccountRuntime } from './claudeSubscriptionRuntime.js';

export const claudeSubscriptionAccountAuthentication: ConnectedAccountPortableRuntime = {
  authentication: claudeSubscriptionConnectedAccountRuntime.authentication,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('claude-subscription', claudeSubscriptionAccountAuthentication);
}
