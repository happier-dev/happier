import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountPortableRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

import { CLOUDFLARE_ACCOUNT_ID, cloudflareConnectedAccountRuntime, materializeCloudflareAccount } from './runtime.js';

export const cloudflarePortableAuthentication: ConnectedAccountPortableRuntime = {
  authentication: cloudflareConnectedAccountRuntime.authentication,
  materialize: materializeCloudflareAccount,
};

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(CLOUDFLARE_ACCOUNT_ID, cloudflarePortableAuthentication);
}
