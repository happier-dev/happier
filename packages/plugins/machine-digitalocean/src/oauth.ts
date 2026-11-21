import {
  buildOAuthAuthorizationCodeForm,
  buildOAuthAuthorizationCodeUrl,
  publicOAuthClientUnavailable,
  requestOAuthEndpoint,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountCredentialStore,
  ConnectedAccountHealthResult,
  ConnectedAccountReadContext,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
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

async function exchange(context: Context, form: URLSearchParams, signal: AbortSignal) {
  let response;
  try {
    response = await requestOAuthEndpoint(context.services.http, tokenUrl, signal, { form });
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
      if (!client) return publicOAuthClientUnavailable('DigitalOcean', 'digitalocean_oauth_public_client_unavailable');
      const authorizationUrl = buildOAuthAuthorizationCodeUrl(issuer + '/v1/oauth/authorize', input, client);
      if (authorizationUrl === null) return reconnect;
      await context.attemptCredentials.set('oauthClientId', client.clientId, { signal });
      // Keep the scope vector in the same form as Cloudflare so the host does not
      // redact a matching space-delimited scope returned by the token endpoint.
      await context.attemptCredentials.set('requestedScopes', JSON.stringify(client.scopes), { signal });
      return { status: 'awaitingOAuthRedirect', authorizationUrl, issuer };
    } catch (error) { return failure(error, signal); }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options);
    try {
      const store = context.attemptCredentials;
      const clientId = await store.get('oauthClientId', { signal });
      const retainedScopes = await store.get('requestedScopes', { signal });
      if (!clientId || !retainedScopes || !input.pkceVerifier) return reconnect;
      const requestedScopes = z.array(text).min(1).safeParse(JSON.parse(retainedScopes));
      if (!requestedScopes.success) return reconnect;
      const grant = await exchange(context, buildOAuthAuthorizationCodeForm(input, clientId), signal);
      const scopes = (grant.scope ?? '').split(/\s+/u).filter(Boolean);
      const granted = new Set(scopes);
      if (requestedScopes.data.some(scope => !granted.has(scope))) return {
        status: 'rejected', diagnostic: diagnostic('permissions_missing',
          'DigitalOcean did not grant the permissions Happier needs. Reconnect and approve them for your team.'),
      };
      if (!grant.info) return { status: 'unavailable', diagnostic: diagnostic('team_missing',
        'DigitalOcean did not identify the team for this sign-in. Reconnect and choose a team.') };
      const identity = { subject: grant.info.uuid, teamId: grant.info.team_uuid, displayName: grant.info.team_name };
      await stage(store, grant, signal);
      for (const [key, value] of Object.entries(identity)) await store.set(key, value, { signal });
      await store.delete('requestedScopes', { signal });
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
    const response = await requestOAuthEndpoint(context.services.http, issuer + '/v1/oauth/revoke', signal, { form: new URLSearchParams({ token }), token });
    if (response.status === 200) return { status: 'remoteRevoked' };
    if ([400, 401, 403, 404].includes(response.status)) return manual;
  } catch { signal.throwIfAborted(); }
  return { status: 'outcomeUnknown', diagnostic: diagnostic('revocation_unknown',
    'DigitalOcean did not confirm revocation. Check Authorized Applications before retrying.') };
};
