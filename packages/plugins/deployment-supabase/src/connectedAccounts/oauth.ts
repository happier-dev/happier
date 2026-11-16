import {
  isPluginError,
  projectActionFailureCauseV1,
  withActionFailureDiagnostic,
} from '@happier-dev/plugin-sdk/errors';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountAuthenticationContext,
  ConnectedAccountAuthenticationModeRuntime,
  ConnectedAccountCredentialStore,
  ConnectedAccountMutationContext,
  ConnectedAccountReadContext,
  ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';

/**
 * Supabase Management API OAuth, checked 2026-11-16:
 * https://api.supabase.com/.well-known/oauth-authorization-server (registration_endpoint,
 * client_secret_basic/post only, S256, RFC 9207 `iss`), and
 * https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration.
 * Each connection registers its own confidential client (RFC 7591), so neither
 * the user nor the Home operator creates a Supabase app and no server holds a
 * client secret. The client travels with the grant in the Account
 * configuration because refresh and revoke need it wherever the account runs.
 */
export const SUPABASE_OAUTH_ISSUER = 'https://api.supabase.com';
const registrationUrl = `${SUPABASE_OAUTH_ISSUER}/platform/oauth/apps/register`;
const tokenUrl = `${SUPABASE_OAUTH_ISSUER}/v1/oauth/token`;
const revokeUrl = `${SUPABASE_OAUTH_ISSUER}/v1/oauth/revoke`;
const organizationsUrl = `${SUPABASE_OAUTH_ISSUER}/v1/organizations`;
/** The x-oauth-scope of every Management API endpoint this plugin calls (Management API OpenAPI). */
export const SUPABASE_OAUTH_SCOPES = [
  'organizations:read',
  'projects:read',
  'projects:write',
  'environment:read',
  'environment:write',
  'database:read',
] as const;
const pendingClientKey = 'oauthPendingClient';

type Context =
  | ConnectedAccountAuthenticationContext
  | ConnectedAccountReadContext;
type Failure = Extract<
  ConnectedAccountAuthCompletionResult,
  { status: 'rejected' | 'unavailable' | 'outcomeUnknown' }
>;
type Client = Readonly<{
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}>;
type Organization = Readonly<{ slug: string; name: string }>;
type Grant = Readonly<{
  token: string;
  refreshToken: string;
  expiresAtMs: number;
  scopes: string[];
}>;

const diagnostic = (code: string) => ({ code, severity: 'error' as const });
class OAuthFailure extends Error {
  constructor(readonly result: Failure) {
    super(result.diagnostic.code);
  }
}
const rejected = (code: string): Failure => ({
  status: 'rejected',
  diagnostic: diagnostic(code),
});
const unavailable = (code = 'supabase_oauth_unavailable'): Failure => ({
  status: 'unavailable',
  diagnostic: diagnostic(code),
});
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const signalOf = (context: Pick<Context, 'signal'>, signal?: AbortSignal) =>
  signal ? AbortSignal.any([context.signal, signal]) : context.signal;
function bodyOf(response: HttpResponse): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(response.body));
  } catch {
    return null;
  }
}
function failure(error: unknown, signal: AbortSignal): Failure {
  signal.throwIfAborted();
  if (error instanceof OAuthFailure) return error.result;
  const failureCause = projectActionFailureCauseV1(error, 'supabase.oauth', {
    allowUnknownErrorCode: isPluginError(error),
  });
  return withActionFailureDiagnostic(
    {
      status: 'unavailable',
      diagnostic: {
        ...diagnostic(failureCause.errorCode ?? 'action_failed'),
        details: { failureCause },
      },
    },
    {
      phase: 'supabase.oauth',
      causeKind: 'native_failure',
      error: new Error(failureCause.errorClass),
    },
  );
}

async function send(
  context: Context,
  url: string,
  signal: AbortSignal,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
  },
) {
  signal.throwIfAborted();
  const response = await context.services.http.request(
    {
      url,
      method: init.method,
      redirect: 'error',
      headers: init.headers,
      ...(init.body === undefined
        ? {}
        : { body: new TextEncoder().encode(init.body) }),
    },
    { signal },
  );
  signal.throwIfAborted();
  if (response.finalUrl !== url) throw new OAuthFailure(unavailable());
  return response;
}
// Supabase's guide sends the raw id:secret pair; both are provider-issued ASCII values.
const basic = (client: Client) =>
  `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;

async function storedClient(
  context: Context,
  signal: AbortSignal,
): Promise<Client | null> {
  const { oauthClientId, oauthRedirectUri } = context.configuration.values;
  const clientSecret = await context.configuration.getSecret(
    'oauthClientSecret',
    { signal },
  );
  return text(oauthClientId) && text(oauthRedirectUri) && text(clientSecret)
    ? { clientId: oauthClientId, clientSecret, redirectUri: oauthRedirectUri }
    : null;
}
/** One RFC 7591 registration per connected account; reconnects reuse it until the Home relay URL changes. */
async function register(
  context: ConnectedAccountAuthenticationContext,
  redirectUri: string,
  signal: AbortSignal,
): Promise<Client> {
  const response = await send(context, registrationUrl, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Happier',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    }),
  });
  const body = bodyOf(response);
  if (
    response.status !== 201 ||
    !isObject(body) ||
    !text(body.client_id) ||
    !text(body.client_secret)
  ) {
    throw new OAuthFailure(
      response.status === 429 || response.status >= 500
        ? unavailable()
        : rejected('supabase_oauth_registration_refused'),
    );
  }
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    redirectUri,
  };
}
function clientConfiguration(
  context: Context,
  client: Client,
  extra: Record<string, JsonValue> = {},
) {
  return {
    values: {
      ...context.configuration.values,
      oauthClientId: client.clientId,
      oauthRedirectUri: client.redirectUri,
      ...extra,
    },
    secretValues: { oauthClientSecret: client.clientSecret },
  };
}

async function exchange(
  context: Context,
  client: Client,
  form: Record<string, string>,
  signal: AbortSignal,
  previous?: Readonly<{ refreshToken: string; scopes: string[] }>,
): Promise<Grant> {
  let response: HttpResponse;
  try {
    response = await send(context, tokenUrl, signal, {
      method: 'POST',
      body: new URLSearchParams(form).toString(),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: basic(client),
      },
    });
  } catch (error) {
    if (error instanceof OAuthFailure) throw error;
    signal.throwIfAborted();
    // A lost reply may already have rotated the refresh grant.
    throw new OAuthFailure({
      status: 'outcomeUnknown',
      diagnostic: diagnostic('supabase_oauth_exchange_unknown'),
    });
  }
  const receivedAtMs = Date.now();
  const body = bodyOf(response);
  if ([400, 401, 403, 404].includes(response.status))
    throw new OAuthFailure(rejected('supabase_oauth_reconnect_required'));
  const refreshToken =
    isObject(body) && body.refresh_token === undefined
      ? previous?.refreshToken
      : isObject(body)
        ? body.refresh_token
        : null;
  if (
    response.status !== 200 ||
    !isObject(body) ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer' ||
    !text(body.access_token) ||
    !text(refreshToken) ||
    typeof body.expires_in !== 'number' ||
    !Number.isSafeInteger(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw new OAuthFailure(unavailable());
  }
  const scopes =
    typeof body.scope === 'string'
      ? [...new Set(body.scope.split(' ').filter(Boolean))]
      : (previous?.scopes ?? []);
  return {
    token: body.access_token,
    refreshToken,
    expiresAtMs: receivedAtMs + body.expires_in * 1000,
    scopes,
  };
}
async function organizationsOf(
  context: Context,
  token: string,
  signal: AbortSignal,
): Promise<Organization[]> {
  const response = await send(context, organizationsUrl, signal, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401)
    throw new OAuthFailure(rejected('supabase_oauth_reconnect_required'));
  if (response.status === 403)
    throw new OAuthFailure(rejected('supabase_organization_unavailable'));
  const body = bodyOf(response);
  if (response.status !== 200 || !Array.isArray(body))
    throw new OAuthFailure(unavailable());
  return body.map((item) => {
    if (
      !isObject(item) ||
      !text(item.slug) ||
      typeof item.name !== 'string' ||
      !item.name.trim()
    )
      throw new OAuthFailure(unavailable());
    return { slug: item.slug, name: item.name };
  });
}
function connected(organization: Organization, scopes: readonly string[]) {
  return {
    status: 'connected' as const,
    displayName: organization.name,
    providerIdentity: {
      accountId: null,
      email: null,
      organizationId: organization.slug,
    },
    scopes,
  };
}
async function stageGrant(
  store: ConnectedAccountCredentialStore,
  grant: Grant,
  signal: AbortSignal,
) {
  for (const [key, value] of Object.entries({
    token: grant.token,
    refreshToken: grant.refreshToken,
    expiresAtMs: String(grant.expiresAtMs),
    scopes: JSON.stringify(grant.scopes),
  })) {
    await store.set(key, value, { signal });
  }
}
async function retainedScopes(
  store: Pick<ConnectedAccountCredentialStore, 'get'>,
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(
      (await store.get('scopes', { signal })) ?? '[]',
    );
    return Array.isArray(value) ? value.filter(text) : [];
  } catch {
    return [];
  }
}
function chosen(
  context: Context,
  organizations: readonly Organization[],
): Organization | undefined {
  const slug = context.configuration.values.organizationSlug;
  return typeof slug === 'string'
    ? organizations.find((item) => item.slug === slug)
    : undefined;
}

export const supabaseOAuthMode: Extract<
  ConnectedAccountAuthenticationModeRuntime,
  { kind: 'oauthAuthorizationCode' }
> = {
  kind: 'oauthAuthorizationCode',
  async begin(input, context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      if (!context.stageAccountConfiguration)
        throw new OAuthFailure(unavailable());
      const stored = await storedClient(context, signal);
      const client =
        stored?.redirectUri === input.callbackUrl
          ? stored
          : await register(context, input.callbackUrl, signal);
      await context.stageAccountConfiguration(
        clientConfiguration(context, client),
      );
      await context.attemptCredentials.set(
        pendingClientKey,
        JSON.stringify(client),
        { signal },
      );
      const url = new URL(`${SUPABASE_OAUTH_ISSUER}/v1/oauth/authorize`);
      url.search = new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: input.callbackUrl,
        response_type: 'code',
        state: input.state,
        code_challenge: input.pkce.challenge,
        code_challenge_method: 'S256',
        scope: SUPABASE_OAUTH_SCOPES.join(' '),
      }).toString();
      return {
        status: 'awaitingOAuthRedirect',
        authorizationUrl: url.href,
        issuer: SUPABASE_OAUTH_ISSUER,
        issuerResponseParameterRequired: true,
      };
    } catch (error) {
      return failure(error, signal);
    }
  },
  async complete(input, context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      const raw = await context.attemptCredentials.get(pendingClientKey, {
        signal,
      });
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      const clientId = isObject(parsed) ? parsed.clientId : null;
      const clientSecret = isObject(parsed) ? parsed.clientSecret : null;
      if (
        !text(clientId) ||
        !text(clientSecret) ||
        !isObject(parsed) ||
        parsed.redirectUri !== input.callbackUrl
      )
        throw new OAuthFailure(rejected('supabase_oauth_attempt_missing'));
      const client: Client = {
        clientId,
        clientSecret,
        redirectUri: input.callbackUrl,
      };
      const grant = await exchange(
        context,
        client,
        {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.callbackUrl,
          code_verifier: input.pkceVerifier,
        },
        signal,
      );
      await context.attemptCredentials.delete(pendingClientKey, { signal });
      await stageGrant(context.attemptCredentials, grant, signal);
      const organizations = await organizationsOf(context, grant.token, signal);
      const organization =
        chosen(context, organizations) ??
        (organizations.length === 1 ? organizations[0] : undefined);
      if (!organization && organizations.length > 1) {
        return {
          status: 'configurationRequired',
          fields: [
            {
              id: 'organizationSlug',
              title: 'Supabase organization',
              required: true,
              secret: false,
              schema: {
                type: 'string',
                enum: organizations.map((item) => item.slug),
              },
              presentation: {
                options: organizations.map((item) => ({
                  value: item.slug,
                  title: item.name,
                })),
              },
            },
          ],
        };
      }
      if (!organization)
        throw new OAuthFailure(rejected('supabase_organization_unavailable'));
      await context.stageAccountConfiguration?.(
        clientConfiguration(context, client, {
          organizationSlug: organization.slug,
        }),
      );
      return connected(organization, grant.scopes);
    } catch (error) {
      return failure(error, signal);
    }
  },
  /** Continues after the organization choice, with the grant already staged on this attempt. */
  async reconcile(context, options) {
    const signal = signalOf(context, options?.signal);
    signal.throwIfAborted();
    try {
      const token = await context.attemptCredentials.get('token', { signal });
      if (!text(token))
        throw new OAuthFailure(rejected('supabase_oauth_reconnect_required'));
      const organization = chosen(
        context,
        await organizationsOf(context, token, signal),
      );
      if (!organization)
        throw new OAuthFailure(rejected('supabase_organization_unavailable'));
      return connected(
        organization,
        await retainedScopes(context.attemptCredentials, signal),
      );
    } catch (error) {
      return failure(error, signal);
    }
  },
  // The host discards attempt custody; no remote transaction exists before the code exchange.
  async cancel() {},
};

export async function refreshSupabaseOAuth(
  context: ConnectedAccountMutationContext,
  options?: { signal?: AbortSignal },
): ReturnType<ConnectedAccountRuntime['refresh']> {
  const signal = signalOf(context, options?.signal);
  signal.throwIfAborted();
  try {
    const client = await storedClient(context, signal);
    const refreshToken = await context.credentials.get('refreshToken', {
      signal,
    });
    if (!client || !text(refreshToken))
      throw new OAuthFailure(rejected('supabase_oauth_reconnect_required'));
    const grant = await exchange(
      context,
      client,
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      signal,
      {
        refreshToken,
        scopes: await retainedScopes(context.credentials, signal),
      },
    );
    // A refresh may rotate the grant, so nothing may fail after the exchange
    // succeeds; the organization is re-checked by the ordinary status probe.
    await stageGrant(context.stagedCredentials, grant, signal);
    return { status: 'connected', scopes: grant.scopes, expiresAt: grant.expiresAtMs };
  } catch (error) {
    const result = failure(error, signal);
    return result.status === 'rejected'
      ? { status: 'reconnectRequired', diagnostic: result.diagnostic }
      : result;
  }
}

export async function revokeSupabaseOAuth(
  context: ConnectedAccountReadContext,
  options?: { signal?: AbortSignal },
): ReturnType<ConnectedAccountRuntime['revoke']> {
  const signal = signalOf(context, options?.signal);
  signal.throwIfAborted();
  try {
    const client = await storedClient(context, signal);
    const refreshToken = await context.credentials.get('refreshToken', {
      signal,
    });
    if (!client || !text(refreshToken))
      return {
        status: 'remoteUnsupported',
        diagnostic: diagnostic('supabase_manual_revoke_required'),
      };
    const response = await send(context, revokeUrl, signal, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
      }),
    });
    if (response.status === 204 || response.status === 200)
      return { status: 'remoteRevoked' };
  } catch {
    signal.throwIfAborted();
  }
  return {
    status: 'outcomeUnknown',
    diagnostic: diagnostic('supabase_oauth_revocation_unknown'),
  };
}
