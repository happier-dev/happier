import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'agent37-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Agent37', keyDescription: 'an Agent37 workspace API key from the Agent37 dashboard', codePrefix: 'agent37',
  purpose: ACCOUNT_PURPOSE,
  headers: [
    { origin: 'https://api.agent37.com', headerName: 'authorization', scheme: 'bearer' },
    { origin: 'https://sandbox.agent37.app', headerName: 'x-agent37-key', scheme: 'raw' },
  ],
  probe: {
    request: { url: 'https://api.agent37.com/v1/instances', method: 'GET' },
    read: value => object(value) && Array.isArray(value.data) ? { status: 'connected', displayName: 'Agent37', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
