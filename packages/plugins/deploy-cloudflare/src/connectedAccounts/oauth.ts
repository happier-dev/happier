import { isPluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import type { ConnectedAccountAuthCompletionResult, ConnectedAccountAuthenticationContext, ConnectedAccountAuthenticationModeRuntime, ConnectedAccountCredentialStore, ConnectedAccountHealthResult, ConnectedAccountMutationContext, ConnectedAccountReadContext, ConnectedAccountRuntime, PluginConnectedAccountConfigurationFieldV2 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { cloudflareEnabledFeatures, cloudflarePermissionNames, cloudflarePermissionScope } from './permissions.js';
import { CLOUDFLARE_API_ORIGIN, diagnostic, isCloudflareId, isObject, validToken } from './probe.js';

export const CLOUDFLARE_CALLBACK_URL = 'https://app.happier.dev/oauth/connected-account/callback';
export const CLOUDFLARE_OAUTH_ORIGIN = 'https://dash.cloudflare.com';
export const CLOUDFLARE_IDENTITY_SCOPES = ['openid', 'offline_access'] as const;
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
type Connected = Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' }>;
type VerifiedIdentity = Connected & Readonly<{ providerIdentity: Readonly<{ accountId: string; organizationId: string }> }>;
type Failure = Extract<ConnectedAccountAuthCompletionResult, { status: 'rejected' | 'unavailable' | 'outcomeUnknown' }>;
type AccountChoice = Readonly<{ id: string; name: string }>;
type PendingSelection = Readonly<{ status: 'selectionRequired'; subject: string; accounts: AccountChoice[] }>;

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
  const configuredAccountId = context.configuration.values.accountId;
  const accountId = configuredAccountId === undefined ? await store.get('accountId', { signal }) ?? undefined : configuredAccountId;
  let { clientId, registeredScopes } = context.configuration.values;
  const modeId = context.configuration.target.modeId;
  if ((accountId !== undefined && !isCloudflareId(accountId)) || modeId !== 'oauth') {
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
      if (!selected) throw new OAuthFailure({ status: 'unavailable', diagnostic: diagnostic('cloudflare_oauth_public_client_unavailable', 'Enter your registered Cloudflare OAuth client ID and API scope IDs to sign in, or connect with an API token.') });
      clientId = selected.clientId;
      registeredScopes = selected.scopes.join(' ');
    } else {
      throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to restore the OAuth client used for this authorization.'));
    }
  }
  const apiScopes = scopesOf(registeredScopes);
  if (!validToken(clientId) || !apiScopes) throw new OAuthFailure(rejected('cloudflare_invalid_configuration', 'Enter both your Cloudflare OAuth client ID and its exact registered API scope IDs, or leave both empty to use this Home’s client.'));
  return { accountId: isCloudflareId(accountId) ? accountId : undefined, clientId, apiScopes, publicClient, scopes: [...new Set([...CLOUDFLARE_IDENTITY_SCOPES, ...apiScopes])],
    permissionNames: ['Account Settings Read'] };
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
 * Cloudflare third-party public-client contract, checked 2026-11-03:
 * https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 * https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/
 * https://developers.cloudflare.com/fundamentals/oauth/authorizing-an-application/
 * Scope IDs come from the registered client's exact configuration. The global
 * catalog only resolves their meaning; ONLY token-response scopes prove grants.
 * AM-1: this establishes identity/grants, never effective operation/write rights.
 */
async function verify(token: string, grants: readonly string[], context: Context, signal: AbortSignal, config: OAuthConfiguration, discover = false): Promise<VerifiedIdentity | PendingSelection> {
  if (!CLOUDFLARE_IDENTITY_SCOPES.every(scope => grants.includes(scope))) throw new OAuthFailure(missingPermissions());
  const catalog = await read(context, `${CLOUDFLARE_API_ORIGIN}/client/v4/oauth/scopes`, token, signal, true);
  if (!Array.isArray(catalog)) throw new OAuthFailure(unavailable());
  for (const name of config.permissionNames) {
    const matching = catalog.filter(item => isObject(item) && item.name === name);
    if (matching.length !== 1) throw new OAuthFailure(missingPermissions());
    const item: unknown = matching[0];
    if (!isObject(item) || typeof item.id !== 'string' || !config.apiScopes.includes(item.id) || !grants.includes(item.id)
      || !Array.isArray(item.scopes) || !item.scopes.includes('com.cloudflare.api.account')) throw new OAuthFailure(missingPermissions());
  }
  const permissions = new Set<string>();
  for (const name of cloudflarePermissionNames) {
    const matching = catalog.filter(item => isObject(item) && item.name === name);
    const item: unknown = matching[0];
    if (matching.length === 1 && isObject(item) && typeof item.id === 'string'
      && config.apiScopes.includes(item.id) && grants.includes(item.id)
      && Array.isArray(item.scopes) && item.scopes.includes(cloudflarePermissionScope(name))) permissions.add(name);
  }
  const features = cloudflareEnabledFeatures(permissions);
  if (features.length === 0) throw new OAuthFailure(missingPermissions());
  const identity = await read(context, `${CLOUDFLARE_OAUTH_ORIGIN}/oauth2/userinfo`, token, signal, false);
  if (!isObject(identity) || !validToken(identity.sub)) throw new OAuthFailure(unavailable());
  let accountId = config.accountId;
  if (!accountId && discover) {
    const accounts = await authorizedAccounts(token, context, signal);
    if (accounts.length === 0) throw new OAuthFailure(missingPermissions());
    if (accounts.length > 1) return { status: 'selectionRequired', subject: identity.sub, accounts };
    accountId = accounts[0]!.id;
  }
  if (!accountId) throw new OAuthFailure(rejected('cloudflare_invalid_configuration', 'Select an authorized Cloudflare account.'));
  const account = await read(context, `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts/${accountId}`, token, signal, true);
  if (!isObject(account) || account.id !== accountId) throw new OAuthFailure(rejected('cloudflare_account_mismatch', 'Cloudflare returned a different account. Check the selected account and reconnect.'));
  if (typeof account.name !== 'string' || !account.name.trim()) throw new OAuthFailure(unavailable());
  return { status: 'connected', displayName: account.name, providerIdentity: { accountId: identity.sub, organizationId: accountId }, scopes: features };
}

function accountField(accounts: readonly AccountChoice[]): PluginConnectedAccountConfigurationFieldV2 {
  return { id: 'accountId', title: 'Cloudflare account', schema: { type: 'string', enum: accounts.map(account => account.id) },
    required: true, secret: false, presentation: { options: accounts.map(account => ({ value: account.id, title: account.name })) } };
}

/** Cloudflare owns consent filtering and pagination; never choose by list order. */
async function authorizedAccounts(token: string, context: Context, signal: AbortSignal): Promise<AccountChoice[]> {
  const accounts = new Map<string, AccountChoice>();
  // The provider's documented maximum page size also lets us finish paging
  // when its optional result_info/total_count metadata is omitted.
  const pageSize = 50;
  let page = 1;
  for (;;) {
    const body = await read(context, `${CLOUDFLARE_API_ORIGIN}/client/v4/accounts?page=${page}&per_page=${pageSize}`, token, signal, false);
    if (!isObject(body) || body.success !== true || !Array.isArray(body.result)) throw new OAuthFailure(unavailable());
    for (const account of body.result) {
      if (!isObject(account) || !isCloudflareId(account.id) || typeof account.name !== 'string' || !account.name.trim()) throw new OAuthFailure(unavailable());
      accounts.set(account.id, { id: account.id, name: account.name });
    }
    const info = body.result_info === undefined ? {} : body.result_info;
    if (!isObject(info)) throw new OAuthFailure(unavailable());
    const perPage = info.per_page === undefined ? pageSize : info.per_page;
    const totalCount = info.total_count;
    if ((info.page !== undefined && info.page !== page) || typeof perPage !== 'number' || !Number.isSafeInteger(perPage) || perPage <= 0
      || (totalCount !== undefined && (typeof totalCount !== 'number' || !Number.isSafeInteger(totalCount) || totalCount < 0))) throw new OAuthFailure(unavailable());
    if (typeof totalCount === 'number' ? page * perPage >= totalCount : body.result.length < perPage) return [...accounts.values()];
    if (body.result.length === 0) throw new OAuthFailure(unavailable());
    page++;
  }
}

async function exchange(context: Context, form: URLSearchParams, signal: AbortSignal, config: OAuthConfiguration, previousRefresh?: string, previousScopes?: readonly string[], discover = false) {
  let response: HttpResponse;
  try { response = await request(context, 'token', signal, { form }); }
  catch (error) {
    signal.throwIfAborted();
    // A public-client refresh may rotate its grant before a reply is lost.
    const failureCause = projectActionFailureCauseV1(error, 'cloudflare.oauth.exchange', { allowUnknownErrorCode: isPluginError(error) });
    throw new OAuthFailure(withActionFailureDiagnostic({ status: 'outcomeUnknown', diagnostic: {
      ...diagnostic(failureCause.errorCode ?? 'action_failed', 'Cloudflare did not confirm the token exchange. Reconnect before trying again.'),
      details: { failureCause },
    } }, { phase: 'cloudflare.oauth.exchange', causeKind: 'native_failure', error: new Error(failureCause.errorClass) }));
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
  const identity = await verify(body.access_token, scopes, context, signal, config, discover);
  if (expiresAtMs <= Date.now()) throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'The Cloudflare authorization expired during verification. Reconnect the account.'));
  return { token: body.access_token, refreshToken, expiresAtMs, identity, grants: scopes };
}
async function stage(store: ConnectedAccountCredentialStore, result: Awaited<ReturnType<typeof exchange>>, config: OAuthConfiguration, signal: AbortSignal) {
  for (const [key, value] of Object.entries({ token: result.token, refreshToken: result.refreshToken,
    scopes: JSON.stringify(result.grants), expiresAtMs: String(result.expiresAtMs),
    ...(result.identity.status === 'connected' ? { accountId: result.identity.providerIdentity.organizationId } : {}),
    subject: result.identity.status === 'connected' ? result.identity.providerIdentity.accountId : result.identity.subject,
    ...(config.publicClient ? { oauthClientId: config.clientId, oauthRegisteredScopes: JSON.stringify(config.apiScopes) } : {}) })) {
    signal.throwIfAborted(); await store.set(key, value, { signal });
  }
  signal.throwIfAborted();
}
function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  if (error instanceof OAuthFailure) return error.result;
  const failureCause = projectActionFailureCauseV1(error, 'cloudflare.oauth', { allowUnknownErrorCode: isPluginError(error) });
  return withActionFailureDiagnostic({ status: 'unavailable', diagnostic: {
    ...diagnostic(failureCause.errorCode ?? 'action_failed', 'Cloudflare authorization failed on this device. Check its network access and reconnect.'),
    details: { failureCause },
  } }, { phase: 'cloudflare.oauth', causeKind: 'native_failure', error: new Error(failureCause.errorClass) });
}
async function retainedScopes(store: Pick<ConnectedAccountCredentialStore, 'get'>, signal: AbortSignal) {
  const raw = await store.get('scopes', { signal });
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
        code: input.code, redirect_uri: input.callbackUrl, code_verifier: input.pkceVerifier }), signal, config, undefined, undefined, true);
      if (result.identity.status === 'selectionRequired') {
        await stage(context.attemptCredentials, result, config, signal);
        return { status: 'configurationRequired', fields: [accountField(result.identity.accounts)] };
      }
      if (!config.accountId) {
        if (!context.stageAccountConfiguration) throw new OAuthFailure(unavailable());
        const accountId = result.identity.providerIdentity.organizationId;
        await context.stageAccountConfiguration({ values: { ...context.configuration.values, accountId },
          fields: [accountField([{ id: accountId, name: result.identity.displayName }])] });
        signal.throwIfAborted();
      }
      await stage(context.attemptCredentials, result, config, signal);
      return result.identity;
    } catch (error) { return failure(error, signal); }
  },
  async reconcile(context, options) {
    const signal = signalOf(context, options?.signal); signal.throwIfAborted();
    try {
      const config = await configuration(context, context.attemptCredentials, signal);
      const token = await context.attemptCredentials.get('token', { signal });
      const expiry = await context.attemptCredentials.get('expiresAtMs', { signal });
      const scopes = await retainedScopes(context.attemptCredentials, signal);
      if (!validToken(token) || !scopes || expiry === null || !Number.isSafeInteger(Number(expiry)) || Number(expiry) <= Date.now()) {
        throw new OAuthFailure(rejected('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to restore this authorization.'));
      }
      const result = await verify(token, scopes, context, signal, config);
      if (result.status !== 'connected') throw new OAuthFailure(unavailable());
      await context.attemptCredentials.set('accountId', result.providerIdentity.organizationId, { signal });
      signal.throwIfAborted();
      return result;
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
    const scopes = await retainedScopes(context.credentials, signal);
    if (!validToken(token) || !scopes || expiry === null || !Number.isSafeInteger(Number(expiry))) return { status: 'reconnectRequired', diagnostic: diagnostic('cloudflare_oauth_reconnect_required', 'Reconnect Cloudflare to restore this authorization.') };
    if (Number(expiry) <= Date.now()) return { status: 'expired' };
    const config = await configuration(context, context.credentials, signal);
    const result = await verify(token, scopes, context, signal, config);
    return result.status === 'connected' ? result : { status: 'unavailable', diagnostic: unavailable().diagnostic };
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
    const scopes = await retainedScopes(context.credentials, signal);
    const result = await exchange(context, new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: refresh }), signal, config, refresh, scopes ?? undefined);
    if (result.identity.status !== 'connected') throw new OAuthFailure(unavailable());
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
