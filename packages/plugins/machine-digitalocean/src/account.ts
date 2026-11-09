import { readDigitalOceanAccountAccess } from './machine/nativeClient.js';
import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';

export const ACCOUNT_ID = 'digitalocean-account';
export const ACCOUNT_PURPOSE = 'cloud-api';

const account = createMachineProvisionerApiKeyAccount({
  name: 'DigitalOcean', keyDescription: 'a DigitalOcean personal access token with the permissions in the Connect checklist', codePrefix: 'digitalocean',
  purpose: ACCOUNT_PURPOSE,
  methods: ['GET', 'POST', 'DELETE'],
  headers: [
    { origin: 'https://api.digitalocean.com', headerName: 'Authorization', scheme: 'bearer' },
  ],
  probe: {
    request: { url: 'https://api.digitalocean.com/v2/account', method: 'GET' },
    read(value) {
      const access = readDigitalOceanAccountAccess(value);
      if (!access) return undefined;
      return access.kind === 'active' ? { status: 'connected', displayName: 'DigitalOcean', scopes: [] }
        : { status: 'rejected', diagnostic: { code: 'digitalocean_account_unavailable', severity: 'error',
          message: 'This DigitalOcean account is not active. Check its status in the DigitalOcean dashboard.' } };
    },
  },
});
export const connectedAccountRuntime = account.runtime;
export const nativeFetch = account.nativeFetch;
