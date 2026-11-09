import { isFreestyleVmList } from './machine/nativeClient.js';
import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'freestyle-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = ['https://api.freestyle.sh'] as const;

const account = createMachineProvisionerApiKeyAccount({
  name: 'Freestyle', keyDescription: 'a Freestyle API key from the Freestyle dashboard', codePrefix: 'freestyle',
  purpose: ACCOUNT_PURPOSE,
  headers: ORIGINS.map(origin => ({ origin, headerName: 'authorization', scheme: 'bearer' as const })),
  probe: {
    request: { url: 'https://api.freestyle.sh/v5/vms?limit=0', method: 'GET' },
    read: value => isFreestyleVmList(value) ? { status: 'connected', displayName: 'Freestyle', providerIdentity: { accountId: null, email: null, organizationId: null }, scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
export const nativeFetch = account.nativeFetch;
