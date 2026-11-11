import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { CODER_PORTABLE_ACCOUNT_RUNTIME } from './machine/connection.js';
import { ACCOUNT_SERVICE } from './machine/schemas.js';
export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register(ACCOUNT_SERVICE.localId, CODER_PORTABLE_ACCOUNT_RUNTIME);
}
