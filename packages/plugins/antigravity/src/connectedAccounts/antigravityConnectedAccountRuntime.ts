import { ANTIGRAVITY_OAUTH_PROFILE } from '@happier-dev/protocol/agents/antigravity/oauth-profile';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { readAntigravityQuota } from './quota.js';
import { readAgyNativeCredential } from './nativeCredentials.js';

type CredentialReader = Parameters<ConnectedAccountRuntime['status']>[0]['credentials'];
type CredentialStore = ConnectedAccountAuthenticationContext['attemptCredentials'];
type Tokens = Readonly<{ accessToken: string; refreshToken: string; expiresAtMs: number | null; scopes: readonly string[]; providerAccountId: string; providerEmail: string }>;
const profile = ANTIGRAVITY_OAUTH_PROFILE;
const tokenFileId = 'antigravity-acp/acp_token.json';
const settingsFileId = 'antigravity-acp/settings.json';

function usesOauthCredentials(modeId: string) { return modeId === 'oauth-personal' || modeId === 'native-import'; }
function diagnostic(code: string, message: string) { return { code, severity: 'error' as const, message }; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function parseBody(body: Uint8Array): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(new TextDecoder().decode(body)); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function parseScopes(value: unknown): readonly string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/u) : [];
  return [...new Set(values.map(text).filter(Boolean))];
}
async function read(credentials: CredentialReader, key: string, options?: Readonly<{ signal?: AbortSignal }>) { return text(await credentials.get(key, options)); }
async function scopes(credentials: CredentialReader, options?: Readonly<{ signal?: AbortSignal }>) {
  const raw = await read(credentials, 'scopes', options);
  let value: unknown = raw;
  try { value = JSON.parse(raw) as unknown; } catch { /* Historical 0.2 OAuth stores a space-separated scope string. */ }
  return parseScopes(value);
}
async function writeOptional(store: CredentialStore, key: string, value: string, options?: Readonly<{ signal?: AbortSignal }>) {
  if (value) await store.set(key, value, options); else await store.delete(key, options);
}
async function writeTokens(store: CredentialStore, tokens: Tokens, options?: Readonly<{ signal?: AbortSignal }>) {
  await store.set('accessToken', tokens.accessToken, options);
  await store.set('refreshToken', tokens.refreshToken, options);
  await store.set('scopes', JSON.stringify(tokens.scopes), options);
  await writeOptional(store, 'providerAccountId', tokens.providerAccountId, options);
  await writeOptional(store, 'providerEmail', tokens.providerEmail, options);
  await writeOptional(store, 'expiresAtMs', tokens.expiresAtMs === null ? '' : String(tokens.expiresAtMs), options);
}
function connected(tokens: Tokens, attempt: ConnectedAccountAuthenticationContext['attempt']) {
  // The host matches this verified ID against the captured reconnect account.
  // Reject missing proof here before either acquisition mode stages a replacement grant.
  if (attempt.kind === 'reconnect' && !tokens.providerAccountId) return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_reconnect_identity_unavailable', 'A verified Antigravity account ID is required to reconnect this account.') };
  return { status: 'connected' as const, displayName: tokens.providerEmail || 'Google Antigravity', scopes: tokens.scopes,
    ...(tokens.providerAccountId ? { accountId: tokens.providerAccountId } : {}),
    ...((tokens.providerAccountId || tokens.providerEmail) ? { providerIdentity: {
      ...(tokens.providerAccountId ? { accountId: tokens.providerAccountId } : {}), ...(tokens.providerEmail ? { email: tokens.providerEmail } : {}),
    } } : {}),
  };
}
async function exchange(body: Readonly<Record<string, string>>, context: Pick<ConnectedAccountAuthenticationContext, 'services' | 'signal'>, fallback?: Tokens, options?: Readonly<{ signal?: AbortSignal }>): Promise<
  | Readonly<{ status: 'success'; tokens: Tokens }>
  | Readonly<{ status: 'rejected'; diagnostic: ReturnType<typeof diagnostic> }> | Readonly<{ status: 'outcomeUnknown'; diagnostic: ReturnType<typeof diagnostic> }>
> {
  const signal = options?.signal ?? context.signal;
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({ url: profile.tokenUrl, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new TextEncoder().encode(new URLSearchParams({ ...body, client_id: profile.clientId, client_secret: profile.clientSecret }).toString()), redirect: 'error' }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'outcomeUnknown', diagnostic: diagnostic('antigravity_oauth_outcome_unknown', 'Google did not return a conclusive Antigravity OAuth result.') };
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 429) return { status: 'rejected', diagnostic: diagnostic('antigravity_oauth_rejected', 'Google rejected the Antigravity OAuth request.') };
  if (response.status < 200 || response.status >= 300) return { status: 'outcomeUnknown', diagnostic: diagnostic('antigravity_oauth_outcome_unknown', 'Google did not return a conclusive Antigravity OAuth result.') };
  const result = parseBody(response.body);
  const accessToken = text(result?.access_token);
  const refreshToken = text(result?.refresh_token) || fallback?.refreshToken || '';
  if (!accessToken || !refreshToken) return { status: 'outcomeUnknown', diagnostic: diagnostic('antigravity_oauth_response_invalid', 'Google returned incomplete Antigravity OAuth credentials.') };
  const returnedScopes = parseScopes(result?.scope);
  return { status: 'success', tokens: { accessToken, refreshToken,
    expiresAtMs: typeof result?.expires_in === 'number' && Number.isFinite(result.expires_in) && result.expires_in > 0 ? Date.now() + Math.trunc(result.expires_in * 1000) : null,
    scopes: result?.scope === undefined ? fallback?.scopes ?? profile.scopes : returnedScopes,
    providerAccountId: fallback?.providerAccountId ?? '', providerEmail: fallback?.providerEmail ?? '',
  } };
}
async function identity(accessToken: string, context: Pick<ConnectedAccountAuthenticationContext, 'services' | 'signal'>, options?: Readonly<{ signal?: AbortSignal }>) {
  const signal = options?.signal ?? context.signal;
  const missing = { providerAccountId: '', providerEmail: '' };
  try {
    const response = await context.services.http.request({ url: profile.userinfoUrl, method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' }, { signal });
    if (response.status === 401) return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_identity_verification_failed', 'Google rejected the selected Antigravity access token.') };
    if (response.status >= 200 && response.status < 300) {
      const result = parseBody(response.body);
      const providerAccountId = text(result?.sub), providerEmail = text(result?.email);
      if (providerAccountId || providerEmail) return { status: 'success' as const, providerAccountId, providerEmail };
    }
  } catch (error) { if (signal.aborted) throw error; }
  context.services.logger.warn('Google Antigravity account identity is unavailable.', { code: 'antigravity_identity_unavailable' });
  return { status: 'success' as const, ...missing };
}

async function importNativeCredentials(source: unknown, context: ConnectedAccountAuthenticationContext, options?: Readonly<{ signal?: AbortSignal }>) {
  const signal = options?.signal ?? context.signal;
  signal.throwIfAborted();
  if (source !== 'acp' && source !== 'cli' && source !== 'cli-file') return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_native_source_unsupported', 'Choose a supported Antigravity native login source.') };
  let native: Awaited<ReturnType<typeof readAgyNativeCredential>>;
  try {
    native = await readAgyNativeCredential(source, message => context.services.logger.warn(message, { code: 'antigravity_native_storage_fallback' }), signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_native_credentials_unavailable', 'The selected Antigravity native login is unavailable.') };
  }
  let accessToken = native.accessToken;
  let refreshToken = native.refreshToken;
  if (!accessToken || (native.expiresAt !== null && native.expiresAt <= Date.now())) {
    const result = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken }, context, {
      accessToken: '', refreshToken, expiresAtMs: null, scopes: [], providerAccountId: '', providerEmail: '',
    }, { signal });
    if (result.status !== 'success') return result;
    accessToken = result.tokens.accessToken;
    refreshToken = result.tokens.refreshToken;
  }
  let response: Awaited<ReturnType<typeof context.services.http.request>>;
  try {
    response = await context.services.http.request({ url: `https://oauth2.googleapis.com/tokeninfo?${new URLSearchParams({ access_token: accessToken })}`, method: 'GET', redirect: 'error' }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'outcomeUnknown' as const, diagnostic: diagnostic('antigravity_native_validation_unavailable', 'Google did not return a conclusive Antigravity login validation.') };
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 429) return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_native_reauthorization_required', 'Sign in to Antigravity again before importing this login.') };
  if (response.status < 200 || response.status >= 300) return { status: 'outcomeUnknown' as const, diagnostic: diagnostic('antigravity_native_validation_unavailable', 'Google did not return a conclusive Antigravity login validation.') };
  const facts = parseBody(response.body);
  const grantedScopes = parseScopes(facts?.scope);
  const expiresIn = typeof facts?.expires_in === 'string' || typeof facts?.expires_in === 'number' ? Number(facts.expires_in) : NaN;
  const providerAccountId = text(facts?.sub), providerEmail = text(facts?.email);
  if (text(facts?.azp) !== profile.clientId || typeof facts?.scope !== 'string' || !profile.scopes.every(scope => grantedScopes.includes(scope)) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { status: 'rejected' as const, diagnostic: diagnostic('antigravity_native_reauthorization_required', 'Sign in to Antigravity again before importing this login.') };
  }
  const tokens: Tokens = { accessToken, refreshToken, expiresAtMs: Date.now() + Math.trunc(expiresIn * 1000), scopes: grantedScopes, providerAccountId, providerEmail };
  const outcome = connected(tokens, context.attempt);
  if (outcome.status !== 'connected') return outcome;
  await writeTokens(context.attemptCredentials, tokens, { signal });
  await writeOptional(context.attemptCredentials, 'projectId', native.projectId ?? '', { signal });
  return outcome;
}

export const antigravityConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { 'oauth-personal': {
    kind: 'oauthAuthorizationCode',
    async begin(input) {
      const query = new URLSearchParams({ client_id: profile.clientId, response_type: 'code', redirect_uri: input.callbackUrl, scope: profile.scopes.join(' '),
        access_type: 'offline', prompt: 'consent', state: input.state, code_challenge: input.pkce.challenge, code_challenge_method: input.pkce.method });
      return { status: 'awaitingOAuthRedirect', authorizationUrl: `${profile.authorizeUrl}?${query}` };
    },
    async complete(input, context, options) {
      const result = await exchange({ grant_type: 'authorization_code', code: input.code, code_verifier: input.pkceVerifier, redirect_uri: input.callbackUrl }, context, undefined, options);
      if (result.status !== 'success') return result;
      const account = await identity(result.tokens.accessToken, context, options);
      if (account.status !== 'success') return account;
      const tokens = { ...result.tokens, providerAccountId: account.providerAccountId, providerEmail: account.providerEmail };
      const outcome = connected(tokens, context.attempt);
      if (outcome.status !== 'connected') return outcome;
      await writeTokens(context.attemptCredentials, tokens, options);
      return outcome;
    },
    async cancel() {},
  }, 'native-import': {
    kind: 'manual',
    async complete(input, context, options) { return await importNativeCredentials(input.fields.source, context, options); },
  } } },
  async refresh(context, options) {
    const refreshToken = await read(context.credentials, 'refreshToken', options);
    if (!refreshToken) return { status: 'reconnectRequired', diagnostic: diagnostic('antigravity_refresh_token_unavailable', 'Reconnect the Antigravity account to restore its refresh token.') };
    const result = await exchange({ grant_type: 'refresh_token', refresh_token: refreshToken }, context, {
      refreshToken, accessToken: await read(context.credentials, 'accessToken', options), expiresAtMs: null, scopes: await scopes(context.credentials, options),
      providerAccountId: await read(context.credentials, 'providerAccountId', options), providerEmail: await read(context.credentials, 'providerEmail', options),
    }, options);
    if (result.status === 'rejected') return { status: 'reconnectRequired', diagnostic: result.diagnostic };
    if (result.status !== 'success') return result;
    await writeTokens(context.stagedCredentials, result.tokens, options);
    await writeOptional(context.stagedCredentials, 'projectId', await read(context.credentials, 'projectId', options), options);
    return { status: 'connected', displayName: result.tokens.providerEmail || 'Google Antigravity', scopes: result.tokens.scopes };
  },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async status(context, options) {
    if (!usesOauthCredentials(context.configuration.target.modeId) || !await read(context.credentials, 'accessToken', options)) return { status: 'unavailable', diagnostic: diagnostic('antigravity_credentials_unavailable', 'Reconnect the Antigravity account to restore its OAuth credentials.') };
    const expiry = Number(await read(context.credentials, 'expiresAtMs', options));
    const facts = { displayName: await read(context.credentials, 'providerEmail', options) || 'Google Antigravity', scopes: await scopes(context.credentials, options) };
    if (Number.isFinite(expiry) && expiry > 0 && expiry <= Date.now()) return { status: 'expired', ...facts, diagnostic: diagnostic('antigravity_access_token_expired', 'The Antigravity access token has expired.') };
    return { status: 'connected', ...facts };
  },
  quota: readAntigravityQuota,
  async materialize(request, context, options) {
    if (!usesOauthCredentials(context.configuration.target.modeId)) throw new Error('Antigravity personal OAuth materialization requires its selected authentication mode.');
    if (request.kind === 'environment') {
      if (request.keys.some((key) => key !== 'AGY_ACP_FORCE_FILE_STORAGE')) throw new Error('Antigravity personal OAuth cannot materialize an unrelated environment key.');
      const env: Record<string, string> = request.keys.includes('AGY_ACP_FORCE_FILE_STORAGE') ? { AGY_ACP_FORCE_FILE_STORAGE: '1' } : {};
      return { kind: 'environment', env };
    }
    if (request.kind !== 'files') throw new Error('Antigravity personal OAuth requires native file materialization.');
    const files: Record<string, Uint8Array> = {};
    if (request.fileIds.includes(tokenFileId)) {
      const accessToken = await read(context.credentials, 'accessToken', options), refreshToken = await read(context.credentials, 'refreshToken', options);
      if (!accessToken || !refreshToken) throw new Error('Antigravity OAuth credentials are unavailable.');
      const expiry = Number(await read(context.credentials, 'expiresAtMs', options)), projectId = await read(context.credentials, 'projectId', options);
      files[tokenFileId] = new TextEncoder().encode(JSON.stringify({ token: accessToken, refresh_token: refreshToken, client_id: profile.clientId, client_secret: profile.clientSecret,
        token_uri: profile.tokenUrl, scopes: await scopes(context.credentials, options), ...(projectId ? { project_id: projectId } : {}),
        ...(Number.isFinite(expiry) && expiry > 0 ? { expiry: new Date(expiry).toISOString() } : {}),
      }));
    }
    if (request.fileIds.includes(settingsFileId)) files[settingsFileId] = new TextEncoder().encode(JSON.stringify({ auth: { type: 'oauth-personal' } }));
    return { kind: 'files', files };
  },
};
