import { PluginError } from '@happier-dev/plugin-sdk';
import { requestDeviceGrantStep, type ConnectedAccountAuthCompletionResult, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { META_INFERENCE_HEADERS, META_API_KEY_ENV_KEY, MUSE_CODE_CREDENTIAL_ENV_KEY, MUSE_NATIVE_AUTH_FILE_ID } from './declarations.js';
import { buildMuseNativeAuth, museRecord, type MuseNativeMetaAuth } from './nativeAuth.js';
import { parseMuseMintCompletionObservation, readMuseQuotaObservation } from './observations.js';

const CLIENT_ID = '1031625952748946';
const META_API_ORIGIN = 'https://api.meta.ai';
const META_HEADERS = { Accept: 'application/json', ...META_INFERENCE_HEADERS };
type AuthContext = Parameters<Extract<ConnectedAccountRuntime['authentication']['modes'][string], { kind: 'oauthDeviceCode' }>['poll']>[0];
type CredentialStore = AuthContext['attemptCredentials'];
type CredentialReader = Pick<CredentialStore, 'get'>;
type SignalOptions = Readonly<{ signal?: AbortSignal }>;

function diagnostic(code: string, reason: string, httpStatus?: number) {
  return { code, severity: 'error' as const, message: 'Muse account operation could not complete.', details: { reason, ...(httpStatus === undefined ? {} : { httpStatus }) } };
}
function nonBlank(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
async function read(store: CredentialReader, key: string, options?: SignalOptions) { return await store.get(key, options) ?? ''; }

/** Named fields remain in the host's existing sealed credential payload. */
export async function stageMuseNativeCredentials(store: CredentialStore, meta: MuseNativeMetaAuth, options?: SignalOptions): Promise<void> {
  await Promise.all([
    store.set('accountToken', meta.access_token, options), store.set('inferenceKey', meta.api_key, options),
    store.set('nativeApiBaseUrl', meta.api_base_url, options), store.set('nativeObtainedVia', meta.obtained_via, options),
    ...([
      ['nativeMechanism', meta.mechanism], ['nativeExpiresAt', meta.expires_at], ['nativeSubsActive', meta.subs_active],
      ['nativeUserEmail', meta.user_email], ['nativeUserFullName', meta.user_full_name],
    ] as const).map(([key, value]) => value === undefined ? store.delete(key, options) : store.set(key, JSON.stringify(value), options)),
  ]);
  await store.set('credentialMode', 'native', options);
}

async function readNativeMeta(store: CredentialReader, options?: SignalOptions): Promise<MuseNativeMetaAuth> {
  const [access_token, api_key, api_base_url, obtained_via, mechanism, expires_at, subs_active, user_email, user_full_name] = await Promise.all([
    'accountToken', 'inferenceKey', 'nativeApiBaseUrl', 'nativeObtainedVia', 'nativeMechanism', 'nativeExpiresAt',
    'nativeSubsActive', 'nativeUserEmail', 'nativeUserFullName',
  ].map(key => read(store, key, options)));
  // These values were parsed once at the HTTP/native-file boundary, then sealed by the host.
  return { access_token, api_key, api_base_url, obtained_via,
    ...(mechanism ? { mechanism: JSON.parse(mechanism) as string } : {}),
    ...(expires_at ? { expires_at: JSON.parse(expires_at) as number } : {}),
    ...(subs_active ? { subs_active: JSON.parse(subs_active) as boolean } : {}),
    ...(user_email ? { user_email: JSON.parse(user_email) as string | null } : {}),
    ...(user_full_name ? { user_full_name: JSON.parse(user_full_name) as string | null } : {}),
  };
}

export async function museAccountConnectedResult(store: CredentialReader, options?: SignalOptions): Promise<Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' }>> {
  const [mode, mechanism, email] = await Promise.all([
    'credentialMode', 'nativeMechanism', 'nativeUserEmail',
  ].map(key => read(store, key, options)));
  const providerEmail = email ? JSON.parse(email) as string | null : null;
  const accountLogin = mode === 'native' && mechanism === '"oauth"';
  return { status: 'connected', credentialKind: accountLogin ? 'oauth' : 'token',
    accessMode: accountLogin ? 'subscription' : 'apiKey',
    displayName: 'Muse', scopes: [], ...(providerEmail ? { providerIdentity: { email: providerEmail } } : {}),
  };
}

async function mintAccountKey(context: AuthContext, options?: SignalOptions): Promise<ConnectedAccountAuthCompletionResult> {
  const signal = options?.signal ?? context.signal;
  await context.attemptCredentials.set('mintStarted', 'true', options);
  let response;
  try {
    response = await context.services.http.request({ url: `${META_API_ORIGIN}/muse-code/key`, method: 'POST', redirect: 'error',
      headers: { ...META_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${await read(context.attemptCredentials, 'accountToken', options)}` },
      body: new TextEncoder().encode('{}'),
    }, { signal });
  } catch (error) {
    signal.throwIfAborted();
    return { status: 'outcomeUnknown', diagnostic: diagnostic('connected_account_authentication_outcome_unknown', 'key_mint_transport') };
  }
  signal.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    const failure = diagnostic('connected_account_authentication_failed', 'key_mint_http', response.status);
    return response.status >= 400 && response.status < 500 && response.status !== 429
      ? { status: 'rejected', diagnostic: failure }
      : { status: 'outcomeUnknown', diagnostic: failure };
  }
  let body: Record<string, unknown> | null;
  try { body = museRecord(JSON.parse(new TextDecoder().decode(response.body))); } catch { body = null; }
  if (body?.require_payment === true || body?.is_subs_active === false) {
    return { status: 'rejected', diagnostic: diagnostic('connected_account_authentication_failed', body.require_payment === true ? 'payment_required' : 'subscription_inactive') };
  }
  if (!body || !nonBlank(body.api_key) || !nonBlank(body.base_url) || typeof body.is_subs_active !== 'boolean') {
    return { status: 'outcomeUnknown', diagnostic: diagnostic('connected_account_authentication_outcome_unknown', 'key_mint_response_invalid') };
  }
  const completionObservation = parseMuseMintCompletionObservation(body, Date.now());
  await stageMuseNativeCredentials(context.attemptCredentials, {
    access_token: await read(context.attemptCredentials, 'accountToken', options), api_key: body.api_key, api_base_url: body.base_url,
    mechanism: 'oauth', obtained_via: 'device_code', subs_active: body.is_subs_active,
    user_email: typeof body.user_email === 'string' ? body.user_email : null,
    user_full_name: typeof body.user_full_name === 'string' ? body.user_full_name : null,
  }, options);
  await Promise.all(['deviceCode', 'devicePollIntervalMs', 'mintStarted'].map(key => context.attemptCredentials.delete(key, options)));
  return { ...await museAccountConnectedResult(context.attemptCredentials, options), includesApiKey: true,
    ...(completionObservation ? { completionObservation } : {}) };
}

export const museConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: {
    device: {
      kind: 'oauthDeviceCode',
      async begin(context, options) {
        const result = await requestDeviceGrantStep({ http: context.services.http,
          url: 'https://auth.meta.com/oidc/device/authorization/', fields: { client_id: CLIENT_ID }, headers: META_HEADERS,
          // RFC 8628 §3.2 supplies five seconds when the authorization response omits interval.
          pollIntervalMs: 5000,
          async parseSuccess(value) {
            const body = museRecord(value);
            if (!body || !nonBlank(body.device_code) || !nonBlank(body.user_code) || !nonBlank(body.verification_uri)
              || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0
              || (body.interval !== undefined && (typeof body.interval !== 'number' || !Number.isFinite(body.interval) || body.interval <= 0))) {
              return { status: 'unavailable' as const, diagnostic: diagnostic('device_grant_response_invalid', 'device_authorization_response') };
            }
            const pollIntervalMs = (typeof body.interval === 'number' ? body.interval : 5) * 1000;
            await context.attemptCredentials.set('deviceCode', body.device_code, options);
            await context.attemptCredentials.set('devicePollIntervalMs', String(pollIntervalMs), options);
            return { status: 'awaitingDeviceAuthorization' as const, verificationUri: body.verification_uri,
              ...(nonBlank(body.verification_uri_complete) ? { verificationUriComplete: body.verification_uri_complete } : {}),
              userCode: body.user_code, expiresAtMs: Date.now() + body.expires_in * 1000, pollIntervalMs };
          },
        }, { signal: options?.signal ?? context.signal });
        return result.status === 'pending'
          ? { status: 'unavailable', diagnostic: diagnostic('device_grant_response_invalid', 'unexpected_begin_pending') } : result;
      },
      async poll(context, options) {
        if (await read(context.attemptCredentials, 'credentialMode', options)) return museAccountConnectedResult(context.attemptCredentials, options);
        if (await read(context.attemptCredentials, 'mintStarted', options)) return { status: 'outcomeUnknown', diagnostic: diagnostic('connected_account_authentication_outcome_unknown', 'key_mint_interrupted') };
        const [deviceCode, interval] = await Promise.all(['deviceCode', 'devicePollIntervalMs'].map(key => read(context.attemptCredentials, key, options)));
        if (!deviceCode || !interval) return { status: 'unavailable', diagnostic: diagnostic('device_grant_response_invalid', 'device_attempt_unavailable') };
        const result = await requestDeviceGrantStep({ http: context.services.http, url: 'https://auth.meta.com/oidc/device/token/',
          fields: { client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode },
          headers: META_HEADERS, pollIntervalMs: Number(interval),
          async parseSuccess(value): Promise<ConnectedAccountAuthCompletionResult> {
            const body = museRecord(value);
            if (!body || !nonBlank(body.access_token)) return { status: 'unavailable', diagnostic: diagnostic('device_grant_response_invalid', 'device_token_response') };
            await context.attemptCredentials.set('accountToken', body.access_token, options);
            if (typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in >= 0) {
              await context.attemptCredentials.set('expiresAtMs', String(Date.now() + body.expires_in * 1000), options);
            }
            return mintAccountKey(context, options);
          },
        }, { signal: options?.signal ?? context.signal });
        if (result.status === 'pending') await context.attemptCredentials.set('devicePollIntervalMs', String(result.retryAfterMs), options);
        return result;
      },
      async cancel() {},
    },
    'api-key': {
      kind: 'manual',
      async complete(input, context, options) {
        if (!nonBlank(input.fields.apiKey)) return { status: 'rejected', diagnostic: diagnostic('connected_account_authentication_failed', 'missing_api_key') };
        await context.attemptCredentials.set('inferenceKey', input.fields.apiKey.trim(), options);
        await context.attemptCredentials.set('credentialMode', 'manual', options);
        return { status: 'connected', credentialKind: 'token', displayName: 'Muse API key', scopes: [] };
      },
    },
  } },
  async refresh() { return { status: 'reconnectRequired', diagnostic: diagnostic('connected_account_refresh_unsupported', 'explicit_reconnect_required') }; },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async status(context, options) {
    const key = await read(context.credentials, 'inferenceKey', options);
    if (!key || !await read(context.credentials, 'credentialMode', options)) return { status: 'unavailable', diagnostic: diagnostic('plugin_connected_account_credentials_unavailable', 'credentials_missing') };
    // Account-token expiry is not the lifetime of the separately minted inference key.
    return museAccountConnectedResult(context.credentials, options);
  },
  async testConnection(context, options) {
    const signal = options?.signal ?? context.signal;
    signal.throwIfAborted();
    const [key, mode, nativeBase] = await Promise.all(['inferenceKey', 'credentialMode', 'nativeApiBaseUrl'].map(name => read(context.credentials, name, { signal })));
    if (!key || !mode) return { status: 'needsReauth', code: 'muse_credentials_unavailable', reason: 'Reconnect Muse to test its connection.' };
    const base = mode === 'native' ? nativeBase.replace(/\/+$/u, '') : `${META_API_ORIGIN}/v1`;
    // Meta's documented authenticated read is /v1/models; MSP usage/read is only a local cache.
    if (base !== `${META_API_ORIGIN}/v1`) return { status: 'unsupported', code: 'muse_test_endpoint_unsupported', reason: 'A connection check is not available for this Muse API server.' };
    let response;
    try {
      response = await context.services.http.request({ url: `${base}/models`, method: 'GET', redirect: 'error',
        headers: { ...META_HEADERS, Authorization: `Bearer ${key}` } }, { signal });
    } catch {
      signal.throwIfAborted();
      return { status: 'networkUnavailable', code: 'muse_test_transport_unavailable', reason: 'Muse could not be reached.' };
    }
    signal.throwIfAborted();
    if (response.status >= 200 && response.status < 300) return { status: 'ok' };
    return { status: response.status === 401 ? 'needsReauth' : response.status === 403 ? 'unsupported' : 'networkUnavailable',
      code: `muse_test_http_${response.status}`, reason: `Muse returned HTTP ${response.status} for the connection check.` };
  },
  async quota() { return readMuseQuotaObservation(); },
  async materialize(request, context, options) {
    const [mode, key, expiry] = await Promise.all(['credentialMode', 'inferenceKey', 'expiresAtMs'].map(name => read(context.credentials, name, options)));
    if (!mode || (!key && (request.kind === 'httpHeaders' || mode !== 'native'))) throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable', message: 'Muse credentials are unavailable; reconnect the account.' });
    if (!key) {
      const [token, mechanism] = await Promise.all(['accountToken', 'nativeMechanism'].map(name => read(context.credentials, name, options)));
      if (!token || mechanism !== '"oauth"' || !expiry || !Number.isFinite(Number(expiry)) || Number(expiry) <= Date.now()) {
        throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable', message: 'The Muse account token is unavailable or expired; reconnect the account.' });
      }
      // Native Muse reads this access-only login from its isolated home and acquires its own inference key.
      if (request.kind === 'environment') return { kind: 'environment', env: {} };
    }
    if (request.kind === 'environment') {
      const env: Record<string, string> = request.keys.includes(META_API_KEY_ENV_KEY) ? { [META_API_KEY_ENV_KEY]: key } : {};
      if (request.keys.includes(MUSE_CODE_CREDENTIAL_ENV_KEY)) {
        const mechanism = await read(context.credentials, 'nativeMechanism', options);
        if (mode !== 'native' || mechanism !== '"oauth"') return { kind: 'environment', env };
        const accessToken = await read(context.credentials, 'accountToken', options);
        if (!accessToken || (expiry && Number(expiry) <= Date.now())) {
          throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable', message: 'The Muse account token is unavailable or expired; reconnect the account.' });
        }
        env[MUSE_CODE_CREDENTIAL_ENV_KEY] = JSON.stringify({ oauthAccessToken: accessToken, apiKey: key });
      }
      return { kind: 'environment', env };
    }
    if (request.kind === 'httpHeaders') {
      if (request.headerNames.some(name => !['authorization', 'x-api-version'].includes(name.toLowerCase()))) {
        throw new PluginError({ code: 'plugin_connected_account_materialization_unsupported', message: 'Muse does not support this credential destination.' });
      }
      const requested = new Set(request.headerNames.map(name => name.toLowerCase()));
      const headers: Record<string, string> = { ...(requested.has('authorization') ? { Authorization: `Bearer ${key}` } : {}), ...(requested.has('x-api-version') ? { ...META_INFERENCE_HEADERS } : {}) };
      return { kind: 'httpHeaders', headers };
    }
    const files: Record<string, Uint8Array> = {};
    if (mode !== 'native') return { kind: 'files', files };
    if (expiry && Number(expiry) <= Date.now()) throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable', message: 'The Muse account token has expired; reconnect the account.' });
    if (request.fileIds.includes(MUSE_NATIVE_AUTH_FILE_ID)) {
      const meta = await readNativeMeta(context.credentials, options);
      if (!meta.access_token) throw new PluginError({ code: 'plugin_connected_account_credentials_unavailable', message: 'The Muse account token is unavailable; reconnect the account.' });
      if (!key) {
        const { api_key: _custodianInferenceKey, ...accessOnlyMeta } = meta;
        files[MUSE_NATIVE_AUTH_FILE_ID] = new TextEncoder().encode(JSON.stringify({ schema_version: 1, providers: { meta: accessOnlyMeta } }));
      } else {
        files[MUSE_NATIVE_AUTH_FILE_ID] = new TextEncoder().encode(JSON.stringify(buildMuseNativeAuth(meta)));
      }
    }
    return { kind: 'files', files };
  },
};

export const museAccountRuntimeDefinition = museConnectedAccountRuntime;
