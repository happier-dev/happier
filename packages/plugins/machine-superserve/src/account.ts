import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'superserve-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const API_ORIGIN = 'https://api.superserve.ai';
export const GUEST_ORIGIN = 'https://sandbox.superserve.ai';
export const SUPERSERVE_ACCESS_PROBE_URL = API_ORIGIN + '/sandboxes?limit=1';

const account = createMachineProvisionerApiKeyAccount({
  name: 'Superserve', keyDescription: 'a Superserve team API key (ss_live_) from console.superserve.ai', codePrefix: 'superserve',
  purpose: ACCOUNT_PURPOSE,
  headers: [
    { origin: API_ORIGIN, headerName: 'x-api-key', scheme: 'raw' },
  ],
  probe: {
    request: { url: SUPERSERVE_ACCESS_PROBE_URL, method: 'GET' },
    read: value => Array.isArray(value) ? { status: 'connected', displayName: 'Superserve', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
