import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { MUSE_ACCOUNT_SERVICE_ID } from './declarations.js';
import { museAccountRuntimeDefinition } from './museAccountRuntime.js';

/** App-side authentication for device and API-key Muse connections. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(MUSE_ACCOUNT_SERVICE_ID, museAccountRuntimeDefinition);
}
