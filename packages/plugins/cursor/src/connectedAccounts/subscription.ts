import type {
  ConnectedAccountPortableRuntime,
  ConnectedAccountPortableAuthenticationContext,
  ConnectedAccountAuthCompletionResult,
  ConnectedAccountRuntime,
  ConnectedAccountCredentialStore,
} from '@happier-dev/plugin-sdk/connected-accounts';

const ORIGIN = 'https://api2.cursor.sh';
const POLL_KEY = 'cursorPoll';
// Cursor's browser flow exposes polling, not a callback or device-code exchange.
// The coordinator owns scheduling/cancellation; the reference starts at one second.
const POLL_INTERVAL_MS = 1000;
export const CURSOR_AUTH_TOKEN_ENV = 'CURSOR_AUTH_TOKEN';
export const CURSOR_CREDENTIAL_STORE_ENV = 'AGENT_CLI_CREDENTIAL_STORE';
export function cursorDiagnostic(code: string) {
  return { code, severity: 'error' as const, message: 'Cursor authentication could not complete. Sign in again or retry.' };
}
type Tokens = Readonly<{ accessToken: string; refreshToken: string }>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Cursor authentication response');
  return value as Record<string, unknown>;
}
function required(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing Cursor authentication field');
  return value;
}
function parseTokens(body: Uint8Array, previousRefreshToken?: string): Tokens {
  const row = object(JSON.parse(new TextDecoder().decode(body)));
  return { accessToken: required(row.accessToken), refreshToken: required(row.refreshToken === undefined ? previousRefreshToken : row.refreshToken) };
}
function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function expiry(token: string): number | undefined {
  // exp is only a scheduling hint; this does not establish JWT authenticity.
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const row = object(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))));
    return typeof row.exp === 'number' && Number.isSafeInteger(row.exp) && row.exp > 0 && Number.isSafeInteger(row.exp * 1000) ? row.exp * 1000 : undefined;
  } catch { return undefined; }
}
async function writeTokens(store: ConnectedAccountCredentialStore, tokens: Tokens, options?: { signal?: AbortSignal }) {
  await store.set('accessToken', tokens.accessToken, options);
  await store.set('refreshToken', tokens.refreshToken, options);
  await store.set('credentialKind', 'oauth', options);
  const expiresAt = expiry(tokens.accessToken);
  if (expiresAt === undefined) await store.delete('expiresAtMs', options);
  else await store.set('expiresAtMs', String(expiresAt), options);
  return expiresAt;
}
export async function saveCursorSubscriptionCredential(tokens: Tokens, context: ConnectedAccountPortableAuthenticationContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountAuthCompletionResult> {
  await writeTokens(context.attemptCredentials, tokens, options);
  return { status: 'connected', credentialKind: 'oauth', displayName: 'Cursor subscription', scopes: [],
    ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}) };
}
export const cursorSubscriptionMode = {
  kind: 'oauthDeviceCode',
  async begin(context, options) {
    const signal = options?.signal ?? context.signal;
    signal.throwIfAborted();
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const uuid = crypto.randomUUID();
    await context.attemptCredentials.set(POLL_KEY, JSON.stringify({ uuid, verifier }), { signal });
    const url = new URL('https://cursor.com/loginDeepControl');
    url.search = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' }).toString();
    return { status: 'awaitingDeviceAuthorization', verificationUri: url.href, verificationUriComplete: url.href, pollIntervalMs: POLL_INTERVAL_MS };
  },
  async poll(context, options) {
    const signal = options?.signal ?? context.signal;
    try {
      const state = object(JSON.parse(await context.attemptCredentials.get(POLL_KEY, { signal }) ?? 'null'));
      const url = new URL(`${ORIGIN}/auth/poll`);
      url.search = new URLSearchParams({ uuid: required(state.uuid), verifier: required(state.verifier) }).toString();
      let response;
      try {
        response = await context.services.http.request({ url: url.href, method: 'GET', redirect: 'error' }, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: 'unavailable', diagnostic: cursorDiagnostic('cursor_poll_transport_unavailable') };
      }
      if (response.status === 404) return { status: 'pending', retryAfterMs: POLL_INTERVAL_MS };
      if ([401, 403, 410].includes(response.status)) return { status: 'rejected', diagnostic: cursorDiagnostic(`cursor_poll_${response.status}`) };
      if (response.status !== 200) return { status: 'unavailable', diagnostic: cursorDiagnostic(`cursor_poll_http_${response.status}`) };
      const result = await saveCursorSubscriptionCredential(parseTokens(response.body), context, { signal });
      await context.attemptCredentials.delete(POLL_KEY, { signal });
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      return { status: 'rejected', diagnostic: cursorDiagnostic('cursor_poll_invalid') };
    }
  },
  async cancel(context, options) { await context.attemptCredentials.delete(POLL_KEY, options); },
} satisfies ConnectedAccountPortableRuntime['authentication']['modes'][string];

export const refreshCursorSubscription: ConnectedAccountRuntime['refresh'] = async (context, options) => {
  const signal = options?.signal ?? context.signal;
  const refreshToken = await context.credentials.get('refreshToken', { signal });
  if (!refreshToken) return { status: 'reconnectRequired', diagnostic: cursorDiagnostic('cursor_refresh_missing') };
  let response;
  try {
    response = await context.services.http.request({ url: `${ORIGIN}/auth/exchange_user_api_key`, method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${refreshToken}`, 'Content-Type': 'application/json' }, body: new TextEncoder().encode('{}') }, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: 'unavailable', diagnostic: cursorDiagnostic('cursor_refresh_transport') };
  }
  if (response.status === 401) return { status: 'reconnectRequired', diagnostic: cursorDiagnostic('cursor_refresh_401') };
  if (response.status !== 200) return { status: 'unavailable', diagnostic: cursorDiagnostic(`cursor_refresh_http_${response.status}`) };
  let tokens;
  try { tokens = parseTokens(response.body, refreshToken); }
  catch { return { status: 'outcomeUnknown', diagnostic: cursorDiagnostic('cursor_refresh_invalid') }; }
  const expiresAt = await writeTokens(context.stagedCredentials, tokens, { signal });
  return { status: 'connected', credentialKind: 'oauth', ...(expiresAt === undefined ? {} : { expiresAt }) };
};
