import type {
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountCredentialStore,
  ConnectedAccountHealthResult,
  ConnectedAccountReadContext,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { z } from 'zod';

const issuer = 'https://cloud.digitalocean.com';
const tokenUrl = issuer + '/v1/oauth/token';
const text = z.string().trim().min(1).regex(/^[^\p{Cc}]+$/u);
const tokenReply = z.object({
  token_type: z.string().refine(value => value.toLowerCase() === 'bearer'),
  access_token: text,
  refresh_token: text,
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  info: z.object({ uuid: text, team_uuid: text, team_name: text }).optional(),
});

type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
type Failure = Extract<ConnectedAccountAuthCompletionResult, { status: 'rejected' | 'unavailable' | 'outcomeUnknown' }>;

function diagnostic(suffix: string, message: string) {
  return { code: 'digitalocean_oauth_' + suffix, severity: 'error' as const, message };
}

const reconnect = { status: 'rejected', diagnostic: diagnostic('reconnect_required',
  'DigitalOcean rejected this sign-in. Reconnect the account.') } as const;
const unavailable = { status: 'unavailable', diagnostic: diagnostic('unavailable',
  'DigitalOcean could not verify this sign-in. Try again.') } as const;

class GrantFailure extends Error {
  constructor(readonly result: Failure) { super(result.diagnostic.code); }
}

function signalOf(context: Pick<Context, 'signal'>, options?: { signal?: AbortSignal }) {
  return options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
}

function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  return error instanceof GrantFailure ? error.result : unavailable;
}

async function post(context: Context, url: string, form: URLSearchParams, signal: AbortSignal, bearer?: string) {
  signal.throwIfAborted();
  const request: HttpRequest = {
    url, method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    body: new TextEncoder().encode(form.toString()),
  };
  const response = await context.services.http.request(request, { signal });
  signal.throwIfAborted();
  if (response.finalUrl !== url || response.status >= 300 && response.status < 400) throw new Error('Unexpected OAuth redirect');
  return response;
}

async function exchange(context: Context, form: URLSearchParams, signal: AbortSignal) {
  let response;
  try {
    response = await post(context, tokenUrl, form, signal);
  } catch {
    signal.throwIfAborted();
    // The code or the single-use refresh token may have been spent.
    throw new GrantFailure({ status: 'outcomeUnknown', diagnostic: diagnostic('exchange_unknown',
      'DigitalOcean did not confirm the sign-in. Reconnect before trying again.') });
  }
  if ([400, 401, 403].includes(response.status)) throw new GrantFailure(reconnect);
  if (response.status !== 200) throw new GrantFailure(unavailable);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(response.body)); }
  catch { throw new GrantFailure(reconnect); }
  const result = tokenReply.safeParse(payload);
  if (!result.success) throw new GrantFailure(reconnect);
  return { ...result.data, expiresAt: Date.now() + result.data.expires_in * 1_000 };
}

type Grant = Awaited<ReturnType<typeof exchange>>;
async function stage(store: ConnectedAccountCredentialStore, grant: Grant, signal: AbortSignal) {
  await store.set('token', grant.access_token, { signal });
  await store.set('refreshToken', grant.refresh_token, { signal });
  await store.set('expiresAtMs', String(grant.expiresAt), { signal });
}

function connected(identity: { subject: string; teamId: string; displayName: string }, expiresAt: number) {
  return { status: 'connected' as const, expiresAt, displayName: identity.displayName,
    providerIdentity: { accountId: identity.subject, organizationId: identity.teamId, email: null } };
}

async function readIdentity(context: ConnectedAccountReadContext, signal: AbortSignal) {
  const subject = await context.credentials.get('subject', { signal });
  const teamId = await context.credentials.get('teamId', { signal });
  const displayName = await context.credentials.get('displayName', { signal });
  if (!subject || !teamId || !displayName) throw new GrantFailure(reconnect);
  return { subject, teamId, displayName };
}

export const digitalOceanOAuthMode: Extract<ConnectedAccountAuthenticationModeRuntime, { kind: 'oauthAuthorizationCode' }> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = signalOf(context, options);
    try {
      const client = await context.configuration.getPublicOAuthClient?.({ signal });
      signal.throwIfAborted();
      if (!client) return { status: 'unavailable', diagnostic: diagnostic('public_client_unavailable',
        'This Home does not offer Sign in with DigitalOcean. Connect with an access token instead.') };
      if (input.pkce.method !== 'S256' || !input.pkce.challenge) return reconnect;
      const scope = client.scopes.join(' ');
      await context.attemptCredentials.set('oauthClientId', client.clientId, { signal });
      await context.attemptCredentials.set('requestedScope', scope, { signal });
      const url = new URL(issuer + '/v1/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: client.clientId, redirect_uri: input.callbackUrl, response_type: 'code', scope,
        state: input.state, code_challenge: input.pkce.challenge, code_challenge_method: 'S256',
      }).toString();
      return { status: 'awaitingOAuthRedirect', authorizationUrl: url.href, issuer };
    } catch (error) { return failure(error, signal); }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options);
    try {
      const store = context.attemptCredentials;
      const clientId = await store.get('oauthClientId', { signal });
      const requestedScope = await store.get('requestedScope', { signal });
      if (!clientId || !requestedScope || !input.pkceVerifier) return reconnect;
      const grant = await exchange(context, new URLSearchParams({
        grant_type: 'authorization_code', client_id: clientId, code: input.code,
        redirect_uri: input.callbackUrl, code_verifier: input.pkceVerifier,
      }), signal);
      const scopes = (grant.scope ?? '').split(/\s+/u).filter(Boolean);
      const granted = new Set(scopes);
      if (requestedScope.split(' ').some(scope => !granted.has(scope))) return {
        status: 'rejected', diagnostic: diagnostic('permissions_missing',
          'DigitalOcean did not grant the permissions Happier needs. Reconnect and approve them for your team.'),
      };
      if (!grant.info) return { status: 'unavailable', diagnostic: diagnostic('team_missing',
        'DigitalOcean did not identify the team for this sign-in. Reconnect and choose a team.') };
      const identity = { subject: grant.info.uuid, teamId: grant.info.team_uuid, displayName: grant.info.team_name };
      await stage(store, grant, signal);
      for (const [key, value] of Object.entries(identity)) await store.set(key, value, { signal });
      await store.delete('requestedScope', { signal });
      return { ...connected(identity, grant.expiresAt), scopes };
    } catch (error) { return failure(error, signal); }
  },
  async cancel() {},
};

export async function digitalOceanOAuthStatus(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = signalOf(context, options);
  try {
    const expiresAt = Number(await context.credentials.get('expiresAtMs', { signal }));
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return { ...reconnect, status: 'reconnectRequired' };
    if (expiresAt <= Date.now()) return { status: 'expired' };
    return connected(await readIdentity(context, signal), expiresAt);
  } catch (error) {
    const result = failure(error, signal);
    return { status: result.status === 'rejected' ? 'reconnectRequired' : 'unavailable', diagnostic: result.diagnostic };
  }
}

export const refreshDigitalOceanOAuth: ConnectedAccountRuntime['refresh'] = async (context, options) => {
  const signal = signalOf(context, options);
  try {
    const refreshToken = await context.credentials.get('refreshToken', { signal });
    if (!refreshToken) throw new GrantFailure(reconnect);
    const identity = await readIdentity(context, signal);
    const grant = await exchange(context, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), signal);
    // DigitalOcean spends the previous refresh token on success.
    if (grant.refresh_token === refreshToken) throw new GrantFailure(reconnect);
    await stage(context.stagedCredentials, grant, signal);
    return connected(identity, grant.expiresAt);
  } catch (error) {
    const result = failure(error, signal);
    return result.status === 'rejected' ? { ...result, status: 'reconnectRequired' } : result;
  }
};

export const revokeDigitalOceanOAuth: ConnectedAccountRuntime['revoke'] = async (context, options) => {
  const signal = signalOf(context, options);
  const manual = { status: 'remoteUnsupported', diagnostic: diagnostic('manual_revoke_required',
    'Remove Happier from Authorized Applications in the DigitalOcean control panel.') } as const;
  try {
    const token = await context.credentials.get('token', { signal });
    if (!token) return manual;
    const response = await post(context, issuer + '/v1/oauth/revoke', new URLSearchParams({ token }), signal, token);
    if (response.status === 200) return { status: 'remoteRevoked' };
    if ([400, 401, 403, 404].includes(response.status)) return manual;
  } catch { signal.throwIfAborted(); }
  return { status: 'outcomeUnknown', diagnostic: diagnostic('revocation_unknown',
    'DigitalOcean did not confirm revocation. Check Authorized Applications before retrying.') };
};
