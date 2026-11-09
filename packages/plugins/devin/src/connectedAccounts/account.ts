import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { devinConnectedAccountRuntime } from './runtime.js';

export const devinAccountAuthentication: ConnectedAccountPortableRuntime = {
  authentication: devinConnectedAccountRuntime.authentication,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('devin-account', devinAccountAuthentication);
}
