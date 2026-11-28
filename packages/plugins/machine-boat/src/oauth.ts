import { z } from 'zod';
import {
  buildOAuthAuthorizationCodeForm,
  buildOAuthAuthorizationCodeUrl,
  publicOAuthClientUnavailable,
  requestOAuthEndpoint,
  type ConnectedAccountAuthenticationModeRuntime,
  type ConnectedAccountCredentialStore,
  type ConnectedAccountReadContext,
  type ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';

const issuer = 'https://boat.dev';
const oauthBase = issuer + '/api/boat/oauth2';

export const boatOAuthScopes = [
  'account.read', 'sandbox.read', 'sandbox.create', 'sandbox.update', 'sandbox.stop', 'sandbox.resume',
  'sandbox.fork', 'sandbox.delete', 'ssh', 'exec', 'file.write', 'snapshot.read', 'snapshot.write',
] as const;

const credentialToken = z.string().regex(/^[^\s\p{Cc}]+$/u);
const grantResponse = z.object({
  token_type: z.string().regex(/^Bearer$/iu),
  access_token: credentialToken,
  refresh_token: credentialToken,
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});

function diagnostic(suffix: string, message: string) {
  return { code: 'boat_oauth_' + suffix, severity: 'error' as const, message };
}

const reconnect = { status: 'rejected', diagnostic: diagnostic('reconnect_required',
  'Boat did not grant a usable connection. Sign in with Boat again.') } as const;
const unavailable = { status: 'unavailable', diagnostic: diagnostic('unavailable',
  'Boat sign-in is temporarily unavailable. Try again.') } as const;
const exchangeUnknown = { status: 'outcomeUnknown', diagnostic: diagnostic('exchange_unknown',
  'Boat did not confirm the token exchange. Reconnect before trying again.') } as const;

function operationSignal(context: { signal: AbortSignal }, options?: { signal?: AbortSignal }) {
  return options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
}

function connected(expiresAt: number, scope: string) {
  return { status: 'connected' as const, displayName: 'Boat', expiresAt, scopes: scope.split(/\s+/u).filter(Boolean) };
}

async function exchange(
  context: Pick<ConnectedAccountReadContext, 'services'>,
  store: ConnectedAccountCredentialStore,
  form: URLSearchParams,
  signal: AbortSignal,
  previous?: Readonly<{ refreshToken: string; scope: string | null }>,
) {
  let response;
  try {
    response = await requestOAuthEndpoint(context.services.http, oauthBase + '/token', signal, { form });
  } catch {
    signal.throwIfAborted();
    return exchangeUnknown;
  }
  if ([400, 401, 403].includes(response.status)) return reconnect;
  if (response.status >= 500) return exchangeUnknown;
  if (response.status !== 200) return unavailable;

  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(response.body)); }
  catch { return reconnect; }
  const grant = grantResponse.safeParse(body);
  // A successful Boat refresh always spends the previous refresh grant.
  if (!grant.success || grant.data.refresh_token === previous?.refreshToken) return reconnect;
  const scope = grant.data.scope ?? previous?.scope;
  if (scope === undefined || scope === null) return reconnect;
  const expiresAt = Date.now() + grant.data.expires_in * 1_000;
  if (!Number.isSafeInteger(expiresAt)) return reconnect;
  await store.set('token', grant.data.access_token, { signal });
  await store.set('refreshToken', grant.data.refresh_token, { signal });
  await store.set('expiresAtMs', String(expiresAt), { signal });
  await store.set('scope', scope, { signal });
  return connected(expiresAt, scope);
}

export const boatOAuthMode: Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'oauthAuthorizationCode' }> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = operationSignal(context, options);
    const client = await context.configuration.getPublicOAuthClient?.({ signal });
    signal.throwIfAborted();
    if (!client) return publicOAuthClientUnavailable('Boat', 'boat_oauth_public_client_unavailable',
      'This Home does not offer Sign in with Boat. Connect with an API key instead.');
    const authorizationUrl = buildOAuthAuthorizationCodeUrl(oauthBase + '/authorize', input, client);
    if (!authorizationUrl) return reconnect;
    await context.attemptCredentials.set('oauthClientId', client.clientId, { signal });
    return { status: 'awaitingOAuthRedirect', authorizationUrl, issuer };
  },
  async complete(input, context, options) {
    const signal = operationSignal(context, options);
    const clientId = await context.attemptCredentials.get('oauthClientId', { signal });
    if (!clientId || !input.pkceVerifier) return reconnect;
    return exchange(context, context.attemptCredentials, buildOAuthAuthorizationCodeForm(input, clientId), signal);
  },
  async cancel() {},
};

export const boatOAuthStatus: ConnectedAccountRuntime['status'] = async (context, options) => {
  const signal = operationSignal(context, options);
  const expiresAt = Number(await context.credentials.get('expiresAtMs', { signal }));
  const scope = await context.credentials.get('scope', { signal });
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || scope === null) return { ...reconnect, status: 'reconnectRequired' };
  return expiresAt <= Date.now() ? { status: 'expired' } : connected(expiresAt, scope);
};

export const refreshBoatOAuth: ConnectedAccountRuntime['refresh'] = async (context, options) => {
  const signal = operationSignal(context, options);
  const clientId = await context.credentials.get('oauthClientId', { signal });
  const refreshToken = await context.credentials.get('refreshToken', { signal });
  if (!clientId || !refreshToken) return { ...reconnect, status: 'reconnectRequired' };
  const scope = await context.credentials.get('scope', { signal });
  const result = await exchange(context, context.stagedCredentials, new URLSearchParams({
    grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken,
  }), signal, { refreshToken, scope });
  return result.status === 'rejected' ? { ...result, status: 'reconnectRequired' } : result;
};

export const revokeBoatOAuth: ConnectedAccountRuntime['revoke'] = async (context, options) => {
  const signal = operationSignal(context, options);
  const manual = { status: 'remoteUnsupported', diagnostic: diagnostic('manual_revoke_required',
    'Disconnect Happier under OAuth apps in the Boat dashboard.') } as const;
  try {
    const token = await context.credentials.get('refreshToken', { signal });
    if (!token) return manual;
    const response = await requestOAuthEndpoint(context.services.http, oauthBase + '/revoke', signal, {
      form: new URLSearchParams({ token }),
    });
    if (response.status >= 200 && response.status < 300) return { status: 'remoteRevoked' };
    if ([400, 401, 403, 404].includes(response.status)) return manual;
  } catch { signal.throwIfAborted(); }
  return { status: 'outcomeUnknown', diagnostic: diagnostic('revocation_unknown',
    'Boat did not confirm revocation. Check OAuth apps in the Boat dashboard.') };
};
