import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';

export const ACCOUNT_ID = 'daytona-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = ['https://app.daytona.io', 'https://proxy.app.daytona.io'] as const;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Daytona', keyDescription: 'a Daytona API key from the Daytona dashboard', codePrefix: 'daytona',
  purpose: ACCOUNT_PURPOSE,
  headers: ORIGINS.map(origin => ({ origin, headerName: 'authorization', scheme: 'bearer' as const })),
  probe: {
    request: { url: 'https://app.daytona.io/api/api-keys/current', method: 'GET' },
    read(value) {
      if (!object(value) || typeof value.name !== 'string' || !value.name.trim()
        || typeof value.organizationId !== 'string' || !value.organizationId.trim()) return undefined;
      return { status: 'connected', displayName: value.name,
        providerIdentity: { accountId: null, email: null, organizationId: value.organizationId }, scopes: [] };
    },
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, account.portableRuntime); }
export const nativeFetch = account.nativeFetch;
