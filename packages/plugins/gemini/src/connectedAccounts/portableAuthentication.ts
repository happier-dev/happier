import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { geminiConnectedAccountRuntime } from './runtime.js';

export const geminiPortableAuthentication: ConnectedAccountPortableRuntime = {
  authentication: geminiConnectedAccountRuntime.authentication,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('gemini-account', geminiPortableAuthentication);
}
