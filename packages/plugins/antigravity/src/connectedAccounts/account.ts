import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { antigravityConnectedAccountRuntime } from './antigravityConnectedAccountRuntime.js';

export const antigravityAccountAuthentication: ConnectedAccountPortableRuntime = {
  authentication: antigravityConnectedAccountRuntime.authentication,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('antigravity-account', antigravityAccountAuthentication);
}
