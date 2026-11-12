import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountPortableRuntime,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { CURSOR_API_KEY_ENV, materializeCursorAuthEnv } from '../agent/auth/status.js';
import { cursorSubscriptionMode, refreshCursorSubscription, CURSOR_AUTH_TOKEN_ENV, CURSOR_CREDENTIAL_STORE_ENV } from './subscription.js';

const API_KEY_CREDENTIAL_KEY = 'apiKey';

const authentication = {
  modes: {
    subscription: cursorSubscriptionMode,
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
  const oauth = await context.credentials.get('credentialKind', options) === 'oauth';
  if (oauth) {
    const token = await context.credentials.get('accessToken', options);
    if (!token) throw new Error('Cursor subscription credentials are unavailable');
    if (request.kind === 'httpHeaders') {
      if (request.origin !== 'https://api2.cursor.sh') throw new Error('Cursor bearer origin is unsupported');
      const headers: Readonly<Record<string, string>> = request.headerNames.some(name => name.toLowerCase() === 'authorization') ? { Authorization: `Bearer ${token}` } : {};
      return { kind: 'httpHeaders', headers };
    }
    if (request.kind !== 'environment') throw new Error('Unsupported Cursor subscription materialization');
    // The CLI otherwise persists injected authentication into the user native store.
    const available: Readonly<Record<string, string>> = { [CURSOR_AUTH_TOKEN_ENV]: token, [CURSOR_CREDENTIAL_STORE_ENV]: 'memory' };
    return { kind: 'environment', env: Object.fromEntries(request.keys.filter(key => key in available).map(key => [key, available[key]])) };
  }
  if (request.kind !== 'environment') throw new Error('Cursor accounts support native environment materialization only');
  if (!request.keys.includes(CURSOR_API_KEY_ENV)) return { kind: 'environment', env: {} };
  const apiKey = await context.credentials.get(API_KEY_CREDENTIAL_KEY, options);
  const env = materializeCursorAuthEnv({ get: () => apiKey ?? undefined });
  if (!env[CURSOR_API_KEY_ENV]) throw new Error('Cursor connected-account API key is unavailable');
  return { kind: 'environment', env };
};

/** Portable manual entry and native delivery share the host's credential custody. */
const testConnection: NonNullable<ConnectedAccountPortableRuntime['testConnection']> = async (context, options) => {
  const signal = options?.signal ?? context.signal;
  signal.throwIfAborted();
  const oauth = await context.credentials.get('credentialKind', { signal }) === 'oauth';
  const token = await context.credentials.get(oauth ? 'accessToken' : API_KEY_CREDENTIAL_KEY, { signal });
  if (!token) return { status: 'needsReauth', code: 'cursor_credentials_unavailable', reason: 'Reconnect Cursor to test its connection.' };
  // CLI API keys first acquire tokens at /auth/exchange_user_api_key; a test must not do that.
  if (!oauth) return { status: 'unsupported', code: 'cursor_api_key_test_unsupported', reason: 'Cursor API-key checks require a sign-in token exchange. A read-only connection check is not available for this mode.' };
  let response;
  try {
    response = await context.services.http.request({ url: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe', method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1', 'x-cursor-client-type': 'cli' },
      body: new Uint8Array() }, { signal });
  } catch {
    signal.throwIfAborted();
    return { status: 'networkUnavailable', code: 'cursor_test_transport_unavailable', reason: 'Cursor could not be reached.' };
  }
  signal.throwIfAborted();
  if (response.status >= 200 && response.status < 300) return { status: 'ok' };
  return { status: response.status === 401 ? 'needsReauth' : response.status === 403 ? 'unsupported' : 'networkUnavailable',
    code: `cursor_test_http_${response.status}`, reason: `Cursor returned HTTP ${response.status} for the connection check.` };
};

export const cursorPortableAccountRuntime: ConnectedAccountPortableRuntime = { authentication, materialize, testConnection };

export function activate(api: PluginAccountApi): void {
  api.connectedAccounts.register('cursor-account', cursorPortableAccountRuntime);
}

const readHealth: ConnectedAccountRuntime['status'] = async (context, options) => {
  if (await context.credentials.get('credentialKind', options) === 'oauth') {
    const token = await context.credentials.get('accessToken', options);
    if (!token) return { status: 'unavailable', diagnostic: { code: 'credentials_unavailable', severity: 'error', message: 'Reconnect the Cursor subscription.' } };
    const expiry = await context.credentials.get('expiresAtMs', options);
    const expiresAt = expiry ? Number(expiry) : undefined;
    return { status: expiresAt !== undefined && expiresAt <= context.invokedAtMs ? 'expired' : 'connected', credentialKind: 'oauth', ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  const apiKey = (await context.credentials.get(API_KEY_CREDENTIAL_KEY, options))?.trim();
  // Connected means stored material is available, not vendor identity or entitlement.
  return apiKey
    ? { status: 'connected', credentialKind: 'token', displayName: 'Cursor API key', scopes: [] }
    : { status: 'unavailable', diagnostic: { code: 'credentials_unavailable', severity: 'error', message: 'The Cursor API key is unavailable; reconnect the account.' } };
};

export const cursorConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication, materialize, testConnection,
  status: readHealth,
  async refresh(context, options) {
    return await context.credentials.get('credentialKind', options) === 'oauth' ? refreshCursorSubscription(context, options) : readHealth(context, options);
  },
  async revoke() { return { status: 'remoteUnsupported' }; },
};
