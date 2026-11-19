import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { digitalOceanOAuthMode, digitalOceanOAuthStatus, refreshDigitalOceanOAuth, revokeDigitalOceanOAuth } from './oauth.js';
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
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  ...account.runtime,
  authentication: { modes: { ...account.runtime.authentication.modes, oauth: digitalOceanOAuthMode } },
  status: (context, options) => context.configuration.target.modeId === 'oauth'
    ? digitalOceanOAuthStatus(context, options) : account.runtime.status(context, options),
  refresh: (context, options) => context.configuration.target.modeId === 'oauth'
    ? refreshDigitalOceanOAuth(context, options) : account.runtime.refresh(context, options),
  revoke: (context, options) => context.configuration.target.modeId === 'oauth'
    ? revokeDigitalOceanOAuth(context, options) : account.runtime.revoke(context, options),
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: connectedAccountRuntime.authentication, materialize: connectedAccountRuntime.materialize,
};
export const nativeFetch = account.nativeFetch;
