import { isMaritimeAccountLimits } from './machine/nativeClient.js';
import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'maritime-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const account = createMachineProvisionerApiKeyAccount({
  name: 'Maritime', keyDescription: 'a Maritime personal API key (mk_) from Maritime Settings', codePrefix: 'maritime',
  purpose: ACCOUNT_PURPOSE,
  headers: [
    { origin: 'https://api.maritime.sh', headerName: 'authorization', scheme: 'bearer' },
  ],
  probe: {
    request: { url: 'https://api.maritime.sh/api/v1/account/limits', method: 'GET' },
    read: value => isMaritimeAccountLimits(value) ? { status: 'connected', displayName: 'Maritime', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
