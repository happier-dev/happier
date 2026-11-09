import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';

export const ACCOUNT_ID = 'hetzner-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Hetzner', keyDescription: 'a Hetzner Cloud API token for the project, not a Robot API credential', codePrefix: 'hetzner',
  purpose: ACCOUNT_PURPOSE,
  methods: ['GET', 'POST', 'DELETE'],
  headers: [
    { origin: 'https://api.hetzner.cloud', headerName: 'Authorization', scheme: 'bearer' },
  ],
  probe: {
    request: { url: 'https://api.hetzner.cloud/v1/servers?page=1&per_page=1', method: 'GET' },
    read: value => object(value) && Array.isArray(value.servers) ? { status: 'connected', displayName: 'Hetzner', scopes: [] } : undefined,
  },
});
export const connectedAccountRuntime = account.runtime;
export const connectedAccountPortableRuntime = account.portableRuntime;
export const nativeFetch = account.nativeFetch;
