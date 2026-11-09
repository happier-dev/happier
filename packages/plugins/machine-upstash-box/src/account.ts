import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'upstash-box-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = ['https://us-east-1.box.upstash.com'] as const;

const account = createMachineProvisionerApiKeyAccount({
  name: 'Upstash Box', keyDescription: 'an Upstash Box API key (box_) from Upstash Console, not a Redis REST token or Developer API key', codePrefix: 'upstash_box',
  purpose: ACCOUNT_PURPOSE,
  headers: ORIGINS.map(origin => ({ origin, headerName: 'x-box-api-key', scheme: 'raw' as const })),
  probe: {
    request: { url: 'https://us-east-1.box.upstash.com/v2/box?label=happier-access-check', method: 'GET' },
    read: value => Array.isArray(value) ? { status: 'connected', displayName: 'Upstash Box', providerIdentity: { accountId: null, email: null, organizationId: null }, scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
export const nativeFetch = account.nativeFetch;
