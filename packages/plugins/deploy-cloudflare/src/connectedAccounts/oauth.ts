import type { ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext, ConnectedAccountAuthenticationModeRuntime, ConnectedAccountCredentialStore, ConnectedAccountHealthResult, ConnectedAccountMutationContext, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { CLOUDFLARE_API_ORIGIN, diagnostic, isCloudflareId, isObject, validToken } from './probe.js';

export const CLOUDFLARE_CALLBACK_URL = 'https://app.happier.dev/oauth/connected-account/callback';
export const CLOUDFLARE_OAUTH_ORIGIN = 'https://dash.cloudflare.com';
export const CLOUDFLARE_IDENTITY_SCOPES = ['openid', 'offline_access'] as const;
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
type Connected = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' }>;
type VerifiedIdentity = Connected & Readonly<{ providerIdentity: Readonly<{ accountId: string; organizationId: string }> }>;
type Failure = Exclude<ConnectedAccountAuthCompletionResult, Connected>;

class OAuthFailure extends Error {
  constructor(readonly result: Failure) { super(result.diagnostic.code); }
}
function rejected(code: string, message: string): Failure {
  return { status: 'rejected', diagnostic: diagnostic(code, message) };
}
function unavailable(): Failure {
  return { status: 'unavailable', diagnostic: diagnostic('cloudflare_oauth_unavailable', 'Cloudflare could not verify this connection. Try again.') };
}
function missingPermissions(): Failure {
  return rejected('cloudflare_missing_permissions', 'Cloudflare did not grant the required access. Check the registered scopes and selected account, then reconnect.');
}
function signalOf(context: Context, signal?: AbortSignal) {
  return signal ? AbortSignal.any([context.signal, signal]) : context.signal;
}
function scopesOf(value: unknown): string[] | null {
  // RFC 6749 scope-token grammar; reject arrays and other coercible shapes.
  return typeof value === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u.test(value)
    ? [...new Set(value.split(' '))] : null;
}
async function configuration(context: Context, store: Pick<ConnectedAccountCredentialStore, 'get'>, signal: AbortSignal, allowPublicDefault = false) {
  const { accountId } = context.configuration.values;
  let { clientId, registeredScopes } = context.configuration.values;
  const modeId = context.configuration.target.modeId;
  if (!isCloudflareId(accountId) || (modeId !== 'workers-oauth' && modeId !== 'pages-oauth')) {
    throw new OAuthFailure(rejected('cloudflare_invalid_configuration', 'Enter the Cloudflare account, registered public client ID and exact API scope IDs.'));
  }
  let publicClient = false;
  if (clientId === undefined && registeredScopes === undefined) {
    const [retainedId, retainedScopes] = await Promise.all([
      store.get('oauthClientId', { signal }), store.get('oauthRegisteredScopes', { signal }),
    ]);
    signal.throwIfAborted();
    publicClient = true;
    if (retainedId !== null || retainedScopes !== null) {
      clientId = retainedId;
      let parsed: unknown;
      try { parsed = retainedScopes === null ? null : JSON.parse(retainedScopes); } catch { parsed = null; }
      registeredScopes = Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed.join(' ') : null;
    } else if (allowPublicDefault) {
      const selected = await context.configuration.getPublicOAuthClient?.({ signal });
      signal.throwIfAborted();
      if (!selected) throw new OAuthFailure({ status: 'unavailable', diagnostic: diagnostic('cloudflare_oauth_public_client_unavailable', 'A Happier Cloudflare OAuth client is not available from this Home. Enter your own client ID and registered API scope IDs, or connect with a scoped API token.') });
      clientId = selected.clientId;
      registeredScopes = selected.scopes.join(' ');
    } else {
      throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to restore the OAuth client used for this authorization.'));
    }
  }
  const apiScopes = scopesOf(registeredScopes);
  if (!validToken(clientId) || !apiScopes) throw new OAuthFailure(rejected('cloudflare_invalid_configuration', 'Enter both your Cloudflare OAuth client ID and its exact registered API scope IDs, or leave both empty to use this Home’s client.'));
  return { accountId, clientId, apiScopes, publicClient, scopes: [...new Set([...CLOUDFLARE_IDENTITY_SCOPES, ...apiScopes])],
    permissionNames: modeId === 'workers-oauth' ? ['Account Settings Read', 'Workers Scripts Write', 'Workers CI Write'] : ['Account Settings Read', 'Pages Write'] };
}
type OAuthConfiguration = Awaited<ReturnType<typeof configuration>>;
function bodyOf(response: HttpResponse): unknown {
  try { return JSON.parse(new TextDecoder().decode(response.body)); } catch { return null; }
}
async function request(context: Context, path: string, signal: AbortSignal, options: { token: string } | { form: URLSearchParams }) {
  signal.throwIfAborted();
  const url = 'token' in options ? path : `${CLOUDFLARE_OAUTH_ORIGIN}/oauth2/${path}`;
  const response = await context.services.http.request({ url, redirect: 'error',
    ...('token' in options ? { method: 'GET' as const, headers: { authorization: `Bearer ${options.token}` } }
      : { method: 'POST' as const, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new TextEncoder().encode(options.form.toString()) }),
  }, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== url || (response.status >= 300 && response.status < 400)) throw new Error('Unexpected OAuth redirect');
  return response;
}
async function read(context: Context, url: string, token: string, signal: AbortSignal, envelope: boolean) {
  const response = await request(context, url, signal, { token });
  if (response.status === 401) throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Cloudflare access has expired or been revoked. Reconnect this account.'));
  if (response.status === 403 || response.status === 404) throw new OAuthFailure(missingPermissions());
  if (response.status !== 200) throw new OAuthFailure(unavailable());
  const body = bodyOf(response);
  if (!isObject(body) || (envelope && body.success !== true)) throw new OAuthFailure(unavailable());
  return envelope ? body.result : body;
}

/**
 * Cloudflare third-party public-client contract, checked 2026-10-27:
 * https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 * https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
 * https://blog.cloudflare.com/task-based-oauth-consent/
 * Scope IDs come from the registered client's exact configuration. The global
 * catalog only resolves their meaning; ONLY token-response scopes prove grants.
 * AM-1: this establishes identity/grants, never effective operation/write rights.
 */
async function verify(token: string, grants: readonly string[], context: Context, signal: AbortSignal, config: OAuthConfiguration): Promise<VerifiedIdentity> {
  if (!config.scopes.every(scope => grants.includes(scope))) throw new OAuthFailure(missingPermissions());
  const catalog = await read(context, `${CLOUDFLARE_API_ORIGIN}/client/v4/oauth/scopes`, token, signal, true);
  if (!Array.isArray(catalog)) throw new OAuthFailure(unavailable());
  for (const name of config.permissionNames) {
    const matching = catalog.filter(item => isObject(item) && item.name === name);
    if (matching.length !== 1) throw new OAuthFailure(missingPermissions());
    const item: unknown = matching[0];
    if (!isObject(item) || typeof item.id !== 'string' || !config.apiScopes.includes(item.id) || !grants.includes(item.id)
      || !Array.isArray(item.scopes) || !item.scopes.includes('com.cloudflare.api.account')) throw new OAuthFailure(missingPermissions());
  }
  const identity = await read(context, `${CLOUDFLARE_OAUTH_ORIGIN}/oauth2/userinfo`, token, signal, false);
  if (!isObject(identity) || !validToken(identity.sub)) throw new OAuthFailure(unavailable());
  const account = await read(context, `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${config.accountId}`, token, signal, true);
  if (!isObject(account) || account.id !== config.accountId) throw new OAuthFailure(rejected('cloudflare_account_mismatch', 'Cloudflare returned a different account. Check the selected account and reconnect.'));
  if (typeof account.name !== 'string' || !account.name.trim()) throw new OAuthFailure(unavailable());
  return { status: 'connected', displayName: account.name, providerIdentity: { accountId: identity.sub, organizationId: config.accountId }, scopes: grants };
}

async function exchange(context: Context, form: URLSearchParams, signal: AbortSignal, config: OAuthConfiguration, previousRefresh?: string, previousScopes?: readonly string[]) {
  let response: HttpResponse;
  try { response = await request(context, 'token', signal, { form }); }
  catch {
    signal.throwIfAborted();
    // A public-client refresh may rotate its grant before a reply is lost.
    throw new OAuthFailure({ status: 'outcomeUnknown', diagnostic: diagnostic('cloudflare_oauth_exchange_unknown', 'Cloudflare did not confirm the token exchange. Reconnect before trying again.') });
  }
  const body = bodyOf(response);
  const receivedAtMs = Date.now();
  if (response.status === 401 || (isObject(body) && typeof body.error === 'string' && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(body.error))) {
    throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Cloudflare rejected this authorization. Reconnect the account.'));
  }
  if (response.status === 403) throw new OAuthFailure(missingPermissions());
  if (response.status !== 200) throw new OAuthFailure(unavailable());
  const scopes = isObject(body) && body.scope === undefined && previousScopes ? [...previousScopes] : isObject(body) ? scopesOf(body.scope) : null;
  const refreshToken = isObject(body) && body.refresh_token === undefined ? previousRefresh : isObject(body) ? body.refresh_token : null;
  if (!isObject(body) || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || !validToken(body.access_token) || !validToken(refreshToken) || !scopes
    || typeof body.expires_in !== 'number' || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 0
    || !Number.isSafeInteger(receivedAtMs + body.expires_in * 1000)) throw new OAuthFailure(unavailable());
  const expiresAtMs = receivedAtMs + body.expires_in * 1000;
  const identity = await verify(body.access_token, scopes, context, signal, config);
  if (expiresAtMs <= Date.now()) throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'The Cloudflare authorization expired during verification. Reconnect the account.'));
  return { token: body.access_token, refreshToken, expiresAtMs, identity };
}
async function stage(store: ConnectedAccountCredentialStore, result: Awaited<ReturnType<typeof exchange>>, config: OAuthConfiguration, signal: AbortSignal) {
  for (const [key, value] of Object.entries({ token: result.token, refreshToken: result.refreshToken,
    scopes: JSON.stringify(result.identity.scopes), expiresAtMs: String(result.expiresAtMs),
    accountId: config.accountId, subject: result.identity.providerIdentity.accountId,
    ...(config.publicClient ? { oauthClientId: config.clientId, oauthRegisteredScopes: JSON.stringify(config.apiScopes) } : {}) })) {
    signal.throwIfAborted(); await store.set(key, value, { signal });
  }
  signal.throwIfAborted();
}
function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted(); return error instanceof OAuthFailure ? error.result : unavailable();
}
async function retainedScopes(context: ConnectedAccountReadContext, signal: AbortSignal) {
  const raw = await context.credentials.get('scopes', { signal });
  let value: unknown;
  try { value = raw === null ? null : JSON.parse(raw); } catch { return null; }
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? scopesOf(value.join(' ')) : null;
}

export const cloudflareOAuthMode: Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'oauthAuthorizationCode' }> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = signalOf(context, options?.signal); signal.throwIfAborted();
    try {
      const config = await configuration(context, context.attemptCredentials, signal, true);
      if (input.callbackUrl !== CLOUDFLARE_CALLBACK_URL || input.pkce.method !== 'S256' || !validToken(input.pkce.challenge)) return rejected('cloudflare_invalid_configuration', 'Restart the connection with its registered callback and PKCE challenge.');
      if (config.publicClient) {
        await context.attemptCredentials.set('oauthClientId', config.clientId, { signal });
        await context.attemptCredentials.set('oauthRegisteredScopes', JSON.stringify(config.apiScopes), { signal });
        signal.throwIfAborted();
      }
      const url = new URL(`${CLOUDFLARE_OAUTH_ORIGIN}/oauth2/auth`);
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: input.callbackUrl, response_type: 'code', scope: config.scopes.join(' '),
        state: input.state, code_challenge: input.pkce.challenge, code_challenge_method: 'S256' }).toString();
      return { status: 'awaitingOAuthRedirect', authorizationUrl: url.href, issuer: CLOUDFLARE_OAUTH_ORIGIN };
    } catch (error) { return failure(error, signal); }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options?.signal); signal.throwIfAborted();
    try {
      const config = await configuration(context, context.attemptCredentials, signal);
      if (input.callbackUrl !== CLOUDFLARE_CALLBACK_URL || !validToken(input.pkceVerifier)) return rejected('cloudflare_invalid_configuration', 'Restart the connection with its registered callback and PKCE verifier.');
      const result = await exchange(context, new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId,
        code: input.code, redirect_uri: input.callbackUrl, code_verifier: input.pkceVerifier }), signal, config);
      await stage(context.attemptCredentials, result, config, signal);
      return result.identity;
    } catch (error) { return failure(error, signal); }
  },
  // The host owns cancellation and discards temporary attempt custody. No remote
  // authorization transaction exists before the admitted code exchange.
  async cancel() {},
};

export async function cloudflareOAuthStatus(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = signalOf(context, options?.signal); signal.throwIfAborted();
  try {
    const expiry = await context.credentials.get('expiresAtMs', { signal });
    const token = await context.credentials.get('token', { signal });
    const scopes = await retainedScopes(context, signal);
    if (!validToken(token) || !scopes || expiry === null || !Number.isSafeInteger(Number(expiry))) return { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to restore this authorization.') };
    if (Number(expiry) <= Date.now()) return { status: 'expired' };
    const config = await configuration(context, context.credentials, signal);
    return await verify(token, scopes, context, signal, config);
  } catch (error) {
    const result = failure(error, signal);
    return { status: result.status === 'rejected' ? 'reconnectRequired' : 'unavailable', diagnostic: result.diagnostic };
  }
}
export async function refreshCloudflareOAuth(context: ConnectedAccountMutationContext, options?: { signal?: AbortSignal }): ReturnType<ConnectedAccountRuntime['refresh']> {
  const signal = signalOf(context, options?.signal); signal.throwIfAborted();
  try {
    const config = await configuration(context, context.credentials, signal);
    const refresh = await context.credentials.get('refreshToken', { signal });
    if (!validToken(refresh)) throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to obtain a refresh grant.'));
    const scopes = await retainedScopes(context, signal);
    const result = await exchange(context, new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refresh }), signal, config, refresh, scopes ?? undefined);
    await stage(context.stagedCredentials, result, config, signal);
    return result.identity;
  } catch (error) {
    const result = failure(error, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired' as const, diagnostic: result.diagnostic } : result;
  }
}
export async function revokeCloudflareOAuth(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): ReturnType<ConnectedAccountRuntime['revoke']> {
  const signal = signalOf(context, options?.signal); signal.throwIfAborted();
  try {
    const config = await configuration(context, context.credentials, signal);
    const token = await context.credentials.get('refreshToken', { signal });
    if (!validToken(token)) return { status: 'remoteUnsupported', diagnostic: diagnostic('cloudflare_oauth_reconnect_required', 'Open your Cloudflare profile to manage this authorization at https://dash.cloudflare.com.') };
    const response = await request(context, 'revoke', signal, { form: new URLSearchParams({ client_id: config.clientId, token, token_type_hint: 'refresh_token' }) });
    if (response.status === 200) return { status: 'remoteRevoked' };
    if (response.status === 403) return { status: 'remoteUnsupported', diagnostic: missingPermissions().diagnostic };
  } catch { signal.throwIfAborted(); }
  return { status: 'outcomeUnknown', diagnostic: diagnostic('cloudflare_oauth_revocation_unknown', 'Cloudflare did not confirm revocation. Check your authorized applications before retrying.') };
}
