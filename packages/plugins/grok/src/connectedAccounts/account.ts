import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { GROK_CONNECTED_ACCOUNT_SERVICE } from './service.js';
import { xaiPortableConnectedAccountRuntime } from './runtime.js';

/** App-side authentication for device and API-key xAI connections. */
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(GROK_CONNECTED_ACCOUNT_SERVICE.localId, xaiPortableConnectedAccountRuntime);
}
