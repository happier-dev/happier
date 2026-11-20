import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { E2B_ACCESS_PROBE_PATH, E2B_API_ORIGIN } from './api.js';

export const ACCOUNT_ID = 'e2b-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const account = createMachineProvisionerApiKeyAccount({
  name: 'E2B', keyDescription: 'an E2B team API key from the E2B dashboard', codePrefix: 'e2b',
  purpose: ACCOUNT_PURPOSE,
  headers: [
    { origin: E2B_API_ORIGIN, headerName: 'x-api-key', scheme: 'raw' },
  ],
  probe: {
    request: { url: E2B_API_ORIGIN + E2B_ACCESS_PROBE_PATH, method: 'GET' },
    read: value => Array.isArray(value) ? { status: 'connected', displayName: 'E2B', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
