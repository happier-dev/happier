import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'e2b-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const account = createMachineProvisionerApiKeyAccount({
  name: 'E2B', keyDescription: 'an E2B team API key from the E2B dashboard', codePrefix: 'e2b',
  purpose: ACCOUNT_PURPOSE,
  headers: [
    { origin: 'https://api.e2b.app', headerName: 'x-api-key', scheme: 'raw' },
  ],
  probe: {
    request: { url: 'https://api.e2b.app/v2/sandboxes', method: 'GET' },
    read: value => Array.isArray(value) ? { status: 'connected', displayName: 'E2B', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
