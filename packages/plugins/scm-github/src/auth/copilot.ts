import type {
  ConnectedAccountPortableAuthenticationContext,
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountPortableRuntime,
  ConnectedAccountHealthResult,
  ConnectedAccountMutationContext,
  ConnectedAccountCredentialStore,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { requestDeviceGrantStep } from '@happier-dev/plugin-sdk/connected-accounts';
import { GITHUB_TOKEN_CREDENTIAL_KEY } from './tokenKinds.js';

type IdentityResult = Readonly<{
  status: 'confirmed'; providerAccountId: string; displayName: string; email?: string; scopes: readonly string[];
}> | Extract<ConnectedAccountAuthCompletionResult, { status: 'rejected' | 'unavailable' }>;
type ConfirmIdentity = (token: string, context: ConnectedAccountPortableAuthenticationContext,
  options?: Readonly<{ signal?: AbortSignal }>) => Promise<IdentityResult>;
type DeviceMode = Extract<ConnectedAccountPortableRuntime['authentication']['modes'][string], { kind: 'oauthDeviceCode' }>;

function unavailable(code: string, message: string) {
  return { status: 'unavailable' as const, diagnostic: { code, message, severity: 'error' as const } };
}

const DEVICE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_GRANT_KEY = 'copilotDeviceGrant';
const CLIENT_KEY = 'oauthClientId';
const REFRESH_KEY = 'refreshToken';
type DeviceGrant = Readonly<{ clientId: string; deviceCode: string; pollIntervalMs: number }>;
type TokenGrant = Readonly<{ accessToken: string; refreshToken?: string; expiresAt?: number }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;
}
function parseTokenGrant(value: unknown): TokenGrant | null {
  const body = record(value);
  const accessToken = text(body?.access_token);
  if (!accessToken) return null;
  const refreshToken = text(body?.refresh_token);
  const lifetime = seconds(body?.expires_in);
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(lifetime ? { expiresAt: Date.now() + lifetime } : {}) };
}
async function stageTokenGrant(store: ConnectedAccountCredentialStore, grant: TokenGrant, clientId: string,
  options?: Readonly<{ signal?: AbortSignal }>) {
  await store.set(GITHUB_TOKEN_CREDENTIAL_KEY, grant.accessToken, options);
  await store.set(CLIENT_KEY, clientId, options);
  await store.set('credentialKind', 'oauth', options);
  if (grant.refreshToken) await store.set(REFRESH_KEY, grant.refreshToken, options);
  if (grant.expiresAt !== undefined) await store.set('expiresAtMs', String(grant.expiresAt), options);
  else await store.delete('expiresAtMs', options);
}
async function post(context: Pick<ConnectedAccountPortableAuthenticationContext, 'services'>, url: string,
  fields: Readonly<Record<string, string>>, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await context.services.http.request({
    method: 'POST', url, redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new TextEncoder().encode(new URLSearchParams(fields).toString()),
  }, { signal });
  let body: Record<string, unknown> | null = null;
  try { body = record(JSON.parse(new TextDecoder().decode(response.body))); } catch { /* Unparseable vendor response. */ }
  return { status: response.status, body };
}
function configurationFailure(body: Record<string, unknown> | null) {
  if (body?.error === 'device_flow_disabled') return unavailable('github_copilot_device_flow_disabled', 'Enable device authorization for the configured GitHub OAuth app.');
  if (body?.error === 'incorrect_client_credentials' || body?.error === 'invalid_client') {
    return unavailable('github_copilot_client_invalid', 'The configured GitHub OAuth client is invalid.');
  }
  return null;
}

export function createGithubCopilotAuthentication(confirmIdentity: ConfirmIdentity): DeviceMode {
  return {
    kind: 'oauthDeviceCode',
    async begin(context, options) {
      const signal = options?.signal ?? context.signal;
      signal.throwIfAborted();
      const client = await context.configuration.getPublicOAuthClient?.({ signal });
      if (!client) return unavailable('github_copilot_client_unavailable', 'GitHub Copilot OAuth client is unavailable.');
      let response;
      try {
        response = await post(context, DEVICE_URL, { client_id: client.clientId, scope: client.scopes.join(' ') }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        return unavailable('github_copilot_device_request_failed', 'GitHub device authorization could not be reached.');
      }
      const failure = configurationFailure(response.body);
      if (failure) return failure;
      const deviceCode = text(response.body?.device_code);
      const userCode = text(response.body?.user_code);
      const verificationUri = text(response.body?.verification_uri);
      const lifetime = seconds(response.body?.expires_in);
      // RFC 8628 specifies five seconds when the authorization response omits interval.
      const pollIntervalMs = seconds(response.body?.interval) ?? 5000;
      if (response.status !== 200 || !deviceCode || !userCode || !verificationUri || !lifetime) {
        return unavailable('github_copilot_device_response_invalid', 'GitHub did not return a usable device authorization.');
      }
      const grant: DeviceGrant = { clientId: client.clientId, deviceCode, pollIntervalMs };
      await context.attemptCredentials.set(DEVICE_GRANT_KEY, JSON.stringify(grant), { signal });
      const verificationUriComplete = text(response.body?.verification_uri_complete);
      return { status: 'awaitingDeviceAuthorization', verificationUri, userCode, expiresAtMs: Date.now() + lifetime,
        pollIntervalMs, ...(verificationUriComplete ? { verificationUriComplete } : {}) };
    },
    async poll(context, options) {
      const signal = options?.signal ?? context.signal;
      signal.throwIfAborted();
      const stored = await context.attemptCredentials.get(DEVICE_GRANT_KEY, { signal });
      if (!stored) return unavailable('github_copilot_device_grant_unavailable', 'GitHub device authorization is unavailable.');
      // Only begin above writes this private attempt record; it never crosses an input boundary.
      const grant = JSON.parse(stored) as DeviceGrant;
      const result = await requestDeviceGrantStep<ConnectedAccountAuthCompletionResult>({
        http: context.services.http, url: TOKEN_URL,
        fields: { client_id: grant.clientId, device_code: grant.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
        pollIntervalMs: grant.pollIntervalMs,
        parseError: body => configurationFailure(record(body)),
        parseSuccess: async body => {
          const token = parseTokenGrant(body);
          if (!token) return unavailable('github_copilot_token_response_invalid', 'GitHub did not return a usable access token.');
          const identity = await confirmIdentity(token.accessToken, context, { signal });
          if (identity.status !== 'confirmed') return identity;
          await stageTokenGrant(context.attemptCredentials, token, grant.clientId, { signal });
          await context.attemptCredentials.delete(DEVICE_GRANT_KEY, { signal });
          return { status: 'connected' as const, credentialKind: 'oauth' as const,
            providerIdentity: { accountId: identity.providerAccountId, ...(identity.email ? { email: identity.email } : {}) },
            displayName: identity.displayName, scopes: identity.scopes };
        },
      }, { signal });
      if (result.status === 'pending' && result.retryAfterMs !== grant.pollIntervalMs) {
        await context.attemptCredentials.set(DEVICE_GRANT_KEY, JSON.stringify({ ...grant, pollIntervalMs: result.retryAfterMs }), { signal });
      }
      return result;
    },
    async cancel(context) { await context.attemptCredentials.delete(DEVICE_GRANT_KEY); },
  };
}

export async function refreshGithubCopilotCredential(
  context: ConnectedAccountMutationContext,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ConnectedAccountHealthResult | null> {
  const signal = options?.signal ?? context.signal;
  signal.throwIfAborted();
  const refreshToken = await context.credentials.get(REFRESH_KEY, { signal });
  if (!refreshToken) return null;
  const clientId = await context.credentials.get(CLIENT_KEY, { signal });
  if (!clientId) return unavailable('github_copilot_client_unavailable', 'The original GitHub OAuth client is unavailable; reconnect this account.');
  let response;
  try {
    response = await post(context, TOKEN_URL, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    return unavailable('github_copilot_refresh_request_failed', 'GitHub token refresh could not be reached.');
  }
  const failure = configurationFailure(response.body);
  if (failure) return failure;
  if (response.body?.error === 'bad_refresh_token' || response.body?.error === 'invalid_grant') {
    return { status: 'reconnectRequired', diagnostic: { code: 'github_copilot_refresh_rejected', severity: 'error', message: 'GitHub rejected the refresh grant; reconnect this account.' } };
  }
  const grant = response.status === 200 && !response.body?.error ? parseTokenGrant(response.body) : null;
  if (!grant) return unavailable('github_copilot_refresh_unavailable', 'GitHub could not refresh this account.');
  await stageTokenGrant(context.stagedCredentials, { ...grant, refreshToken: grant.refreshToken ?? refreshToken }, clientId, { signal });
  return { status: 'connected', credentialKind: 'oauth', ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) };
}
