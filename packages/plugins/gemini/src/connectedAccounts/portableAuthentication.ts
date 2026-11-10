import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { geminiConnectedAccountRuntime } from './runtime.js';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from './service.js';

export const geminiPortableAuthentication: ConnectedAccountPortableRuntime = {
  authentication: geminiConnectedAccountRuntime.authentication,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(GEMINI_CONNECTED_ACCOUNT_SERVICE.localId, geminiPortableAuthentication);
}
