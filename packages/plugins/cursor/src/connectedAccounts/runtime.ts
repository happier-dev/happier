import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountPortableRuntime,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { CURSOR_API_KEY_ENV, materializeCursorAuthEnv } from '../agent/auth/status.js';

const API_KEY_CREDENTIAL_KEY = 'apiKey';

const authentication = {
  modes: {
    'api-key': {
      kind: 'manual',
      async complete(input, context, options) {
        const apiKey = input.fields.token?.trim() ?? '';
        if (!apiKey) return {
          status: 'rejected',
          diagnostic: { code: 'connected_account_manual_fields_invalid', severity: 'error', message: 'Enter a Cursor user or service API key.' },
        };
        await context.attemptCredentials.set(API_KEY_CREDENTIAL_KEY, apiKey, options);
        return {
          status: 'connected', credentialKind: 'token', displayName: 'Cursor API key', scopes: [],
          ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}),
        };
      },
    },
  },
} satisfies ConnectedAccountPortableRuntime['authentication'];

const materialize: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options) => {
  if (request.kind !== 'environment') throw new Error('Cursor accounts support native environment materialization only');
  if (!request.keys.includes(CURSOR_API_KEY_ENV)) return { kind: 'environment', env: {} };
  const apiKey = await context.credentials.get(API_KEY_CREDENTIAL_KEY, options);
  const env = materializeCursorAuthEnv({ get: () => apiKey ?? undefined });
  if (!env[CURSOR_API_KEY_ENV]) throw new Error('Cursor connected-account API key is unavailable');
  return { kind: 'environment', env };
};

/** Portable manual entry and native delivery share the host's credential custody. */
export const cursorPortableAccountRuntime: ConnectedAccountPortableRuntime = { authentication, materialize };

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('cursor-account', cursorPortableAccountRuntime);
}

const readHealth: ConnectedAccountRuntime['status'] = async (context, options) => {
  const apiKey = (await context.credentials.get(API_KEY_CREDENTIAL_KEY, options))?.trim();
  // Connected means stored material is available, not vendor identity or entitlement.
  return apiKey
    ? { status: 'connected', credentialKind: 'token', displayName: 'Cursor API key', scopes: [] }
    : { status: 'unavailable', diagnostic: { code: 'credentials_unavailable', severity: 'error', message: 'The Cursor API key is unavailable; reconnect the account.' } };
};

export const cursorConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication, materialize,
  status: readHealth,
  refresh: readHealth,
  async revoke() { return { status: 'remoteUnsupported' }; },
};
