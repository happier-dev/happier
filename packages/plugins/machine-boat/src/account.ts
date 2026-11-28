import { createMachineProvisionerApiKeyAccount } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ConnectedAccountPortableRuntime, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { BoatLimitsResponseSchema } from './machine/nativeClient.js';
import { boatSetupMessage } from './machine/schemas.js';
import { boatOAuthMode, boatOAuthStatus, refreshBoatOAuth, revokeBoatOAuth } from './oauth.js';

export const ACCOUNT_ID = 'boat-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const BOAT_NATIVE_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const account = createMachineProvisionerApiKeyAccount({
  name: 'Boat', keyDescription: 'a Boat API key (boat_) with the permissions in the Connect checklist', codePrefix: 'boat',
  purpose: ACCOUNT_PURPOSE,
  methods: BOAT_NATIVE_HTTP_METHODS,
  headers: [
    { origin: 'https://boat.dev', headerName: 'Authorization', scheme: 'bearer' },
  ],
  probe: {
    request: { url: 'https://boat.dev/api/v1/limits', method: 'GET' },
    rejection(status, value) {
      if (status < 400 || status >= 500 || !object(value) || value.ok !== false || typeof value.code !== 'string') return undefined;
      const code = `native_${value.code}`;
      const message = boatSetupMessage(code);
      return message ? { status: 'rejected', diagnostic: { code, severity: 'error', message } } : undefined;
    },
    read(value) {
      return BoatLimitsResponseSchema.safeParse(value).success
        ? { status: 'connected', displayName: 'Boat', scopes: [] } : undefined;
    },
  },
});
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  ...account.runtime,
  authentication: { modes: { ...account.runtime.authentication.modes, oauth: boatOAuthMode } },
  status: (context, options) => context.configuration.target.modeId === 'oauth'
    ? boatOAuthStatus(context, options) : account.runtime.status(context, options),
  refresh: (context, options) => context.configuration.target.modeId === 'oauth'
    ? refreshBoatOAuth(context, options) : account.runtime.refresh(context, options),
  revoke: (context, options) => context.configuration.target.modeId === 'oauth'
    ? revokeBoatOAuth(context, options) : account.runtime.revoke(context, options),
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: connectedAccountRuntime.authentication, materialize: connectedAccountRuntime.materialize,
};
export const nativeFetch = account.nativeFetch;
