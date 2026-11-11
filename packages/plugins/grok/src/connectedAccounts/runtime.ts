import {
  parseConnectedAccountTokenEndpointFailure,
  requestDeviceGrantStep,
  type ConnectedAccountAuthenticationContext,
  type ConnectedAccountAuthCompletionResult,
  type ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { readXaiCredential, type XaiCredential } from './credential.js';
import { fetchXaiQuota } from './quota.js';
import { readXaiPolicyReason } from './failures.js';
import { GROK_XAI_CLIENT_ID, GROK_XAI_ISSUER, readGrokNativeCredential, serializeGrokSelectedAuth } from './nativeCredentials.js';
import { GROK_CONNECTED_ACCOUNT_MODE_ENV } from '../agent/connectedAccount.js';
import { XAI_SELECTED_API_KEY_ENV } from './service.js';

export const XAI_CREDENTIAL_KEY = 'xaiCredential';
const DEVICE_KEY = 'xaiDevice';
export const XAI_DEVICE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'] as const;
const SCOPE = XAI_DEVICE_SCOPES.join(' ');
const BASES = { 'api-key': 'https://api.x.ai/v1', subscription: 'https://cli-chat-proxy.grok.com/v1' } as const;
const diagnostic = (code: string) => ({ code, severity: 'error' as const, message: 'The xAI operation could not complete.' });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid xAI response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing xAI response field');
  return value;
}
function endpoint(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid xAI endpoint');
  return url.href;
}
function parseToken(body: unknown, nowMs: number, previous?: XaiCredential): XaiCredential {
  const row = object(body);
  const expiresIn = row.expires_in;
  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)) throw new Error('Invalid xAI token expiry');
  return {
    ...previous, mode: 'subscription', accessToken: text(row.access_token),
    ...(typeof row.refresh_token === 'string' ? { refreshToken: text(row.refresh_token) } : {}),
    ...(typeof expiresIn === 'number' ? { expiresAtMs: nowMs + expiresIn * 1000 } : { expiresAtMs: undefined }),
    ...(typeof row.token_type === 'string' ? { tokenType: row.token_type } : {}),
    ...(typeof row.scope === 'string' ? { scope: row.scope } : {}),
  };
}
type DeviceState = Readonly<{ deviceCode: string; tokenEndpoint: string; pollIntervalMs: number }>;
function parseDeviceState(value: string | null): DeviceState {
  const row = object(JSON.parse(value ?? 'null'));
  if (typeof row.pollIntervalMs !== 'number' || row.pollIntervalMs <= 0) throw new Error('Invalid xAI device interval');
  return { deviceCode: text(row.deviceCode), tokenEndpoint: endpoint(row.tokenEndpoint), pollIntervalMs: row.pollIntervalMs };
}
async function saveCredential(credential: XaiCredential, context: ConnectedAccountAuthenticationContext): Promise<ConnectedAccountAuthCompletionResult> {
  await context.attemptCredentials.set(XAI_CREDENTIAL_KEY, JSON.stringify(credential));
  return { status: 'connected', credentialKind: credential.mode === 'api-key' ? 'token' : 'oauth',
    ...(credential.subject ? { providerIdentity: { accountId: credential.subject, ...(credential.email ? { email: credential.email } : {}) } } : {}),
    displayName: credential.email ?? (credential.mode === 'api-key' ? 'xAI paid API key' : 'xAI subscription'),
    scopes: credential.scope?.split(/\s+/).filter(Boolean) ?? [],
  };
}

export function createXaiConnectedAccountRuntime(): ConnectedAccountRuntime {
  return {
    authentication: { modes: {
      'api-key': { kind: 'manual', async complete(input, context) {
        const key = input.fields.apiKey?.trim();
        if (!key) return { status: 'rejected', diagnostic: diagnostic('xai_api_key_missing') };
        return saveCredential({ mode: 'api-key', accessToken: key }, context);
      } },
      'native-import': { kind: 'manual', async complete(input, context, options) {
        if (input.fields.source !== 'native') return { status: 'rejected', diagnostic: diagnostic('xai_native_source_required') };
        const signal = options?.signal ?? context.signal;
        let credential: XaiCredential;
        try {
          credential = await readGrokNativeCredential({ signal });
        } catch (error) {
          if (signal.aborted) throw error;
          if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
            return { status: 'unavailable', diagnostic: diagnostic('xai_native_file_unavailable') };
          }
          return { status: 'rejected', diagnostic: diagnostic('xai_native_schema_unsupported') };
        }
        return saveCredential(credential, context);
      } },
      device: { kind: 'oauthDeviceCode', async begin(context, options) {
        const signal = options?.signal ?? context.signal;
        try {
          const response = await context.services.http.request({ url: `${GROK_XAI_ISSUER}/.well-known/openid-configuration`, method: 'GET', redirect: 'error' }, { signal });
          if (response.status !== 200) return { status: 'unavailable', diagnostic: diagnostic('xai_discovery_unavailable') };
          const discovery = object(JSON.parse(new TextDecoder().decode(response.body)));
          const deviceEndpoint = endpoint(discovery.device_authorization_endpoint);
          const tokenEndpoint = endpoint(discovery.token_endpoint);
          const result = await requestDeviceGrantStep({ http: context.services.http, url: deviceEndpoint,
            fields: { client_id: GROK_XAI_CLIENT_ID, scope: SCOPE }, pollIntervalMs: 5000,
            async parseSuccess(body) {
              const row = object(body);
              if (typeof row.expires_in !== 'number' || !Number.isFinite(row.expires_in) || row.expires_in <= 0) throw new Error('Invalid xAI device expiry');
              const interval = row.interval === undefined ? 5 : row.interval;
              if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) throw new Error('Invalid xAI device interval');
              const pollIntervalMs = interval * 1000;
              const deviceCode = text(row.device_code);
              const verificationUri = endpoint(row.verification_uri);
              const userCode = text(row.user_code);
              const verificationUriComplete = row.verification_uri_complete === undefined ? undefined : endpoint(row.verification_uri_complete);
              await context.attemptCredentials.set(DEVICE_KEY, JSON.stringify({ deviceCode, tokenEndpoint, pollIntervalMs }), { signal });
              return { status: 'awaitingDeviceAuthorization' as const, verificationUri, userCode,
                ...(verificationUriComplete ? { verificationUriComplete } : {}),
                expiresAtMs: context.invokedAtMs + row.expires_in * 1000, pollIntervalMs };
            },
          }, { signal });
          return result.status === 'pending' ? { status: 'unavailable', diagnostic: diagnostic('xai_device_begin_invalid') } : result;
        } catch (error) {
          if (signal.aborted) throw error;
          return { status: 'unavailable', diagnostic: diagnostic('xai_discovery_invalid') };
        }
      }, async poll(context, options) {
        const signal = options?.signal ?? context.signal;
        const device = parseDeviceState(await context.attemptCredentials.get(DEVICE_KEY, { signal }));
        const result = await requestDeviceGrantStep({ http: context.services.http, url: device.tokenEndpoint,
          fields: { client_id: GROK_XAI_CLIENT_ID, device_code: device.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
          pollIntervalMs: device.pollIntervalMs,
          async parseSuccess(body) {
            const credential: XaiCredential = { ...parseToken(body, context.invokedAtMs), issuer: GROK_XAI_ISSUER, tokenEndpoint: device.tokenEndpoint, clientId: GROK_XAI_CLIENT_ID };
            let identified = credential;
            try {
              const identity = await context.services.http.request({ url: `${GROK_XAI_ISSUER}/oauth2/userinfo`, method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${credential.accessToken}` } }, { signal });
              if (identity.status === 200) {
                const row = object(JSON.parse(new TextDecoder().decode(identity.body)));
                if (typeof row.sub === 'string' && row.sub) {
                  identified = { ...credential, subject: row.sub, ...(typeof row.email === 'string' ? { email: row.email } : {}) };
                }
              }
            } catch (error) {
              if (signal.aborted) throw error;
            }
            return saveCredential(identified, context);
          },
        }, { signal });
        if (result.status === 'pending' && result.retryAfterMs !== device.pollIntervalMs) {
          await context.attemptCredentials.set(DEVICE_KEY, JSON.stringify({ ...device, pollIntervalMs: result.retryAfterMs }), { signal });
        }
        return result;
      }, async cancel(context) { await context.attemptCredentials.delete(DEVICE_KEY); } },
    } },
    async status(context, options) {
      const credential = readXaiCredential(await context.credentials.get(XAI_CREDENTIAL_KEY, options));
      return { status: credential.expiresAtMs !== undefined && credential.expiresAtMs <= context.invokedAtMs ? 'expired' : 'connected',
        credentialKind: credential.mode === 'api-key' ? 'token' : 'oauth', ...(credential.expiresAtMs ? { expiresAt: credential.expiresAtMs } : {}) };
    },
    async refresh(context, options) {
      const signal = options?.signal ?? context.signal;
      const credential = readXaiCredential(await context.credentials.get(XAI_CREDENTIAL_KEY, { signal }));
      if (credential.mode === 'api-key') return { status: 'connected', credentialKind: 'token' };
      if (!credential.refreshToken || !credential.clientId) return { status: 'unavailable', diagnostic: diagnostic('xai_refresh_unavailable') };
      try {
        let tokenEndpoint = credential.tokenEndpoint;
        if (!tokenEndpoint) {
          const discovery = await context.services.http.request({ url: `${credential.issuer ?? GROK_XAI_ISSUER}/.well-known/openid-configuration`, method: 'GET', redirect: 'error' }, { signal });
          if (discovery.status !== 200) return { status: 'unavailable', diagnostic: diagnostic('xai_refresh_discovery_unavailable') };
          tokenEndpoint = endpoint(object(JSON.parse(new TextDecoder().decode(discovery.body))).token_endpoint);
        }
        const response = await context.services.http.request({ url: tokenEndpoint, method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new TextEncoder().encode(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: credential.clientId }).toString()) }, { signal });
        if (response.status < 200 || response.status >= 300) {
          const failure = parseConnectedAccountTokenEndpointFailure(response);
          const policyReason = response.status === 403 ? readXaiPolicyReason(response.body) : undefined;
          return { status: failure.kind === 'invalid_grant' || failure.kind === 'invalid_client' ? 'reconnectRequired' : 'unavailable', diagnostic: diagnostic(`xai_refresh_${policyReason ?? failure.providerErrorCode ?? response.status}`) };
        }
        const refreshed = parseToken(JSON.parse(new TextDecoder().decode(response.body)), context.invokedAtMs, { ...credential, tokenEndpoint });
        await context.stagedCredentials.set(XAI_CREDENTIAL_KEY, JSON.stringify(refreshed), { signal });
        return { status: 'connected', credentialKind: 'oauth', ...(refreshed.expiresAtMs ? { expiresAt: refreshed.expiresAtMs } : {}) };
      } catch (error) {
        if (signal.aborted) throw error;
        return { status: 'unavailable', diagnostic: diagnostic('xai_refresh_invalid') };
      }
    },
    async revoke() { return { status: 'remoteUnsupported' }; },
    async quota(context, options) {
      const credential = readXaiCredential(await context.credentials.get(XAI_CREDENTIAL_KEY, options));
      return fetchXaiQuota({ http: context.services.http, credential, signal: options?.signal ?? context.signal, nowMs: context.invokedAtMs });
    },
    async materialize(request, context, options) {
      const credential = readXaiCredential(await context.credentials.get(XAI_CREDENTIAL_KEY, options));
      if (request.kind === 'environment') {
        const available: Readonly<Record<string, string>> = {
          [GROK_CONNECTED_ACCOUNT_MODE_ENV]: credential.mode,
          ...(credential.mode === 'api-key' ? { XAI_API_KEY: credential.accessToken, [XAI_SELECTED_API_KEY_ENV]: credential.accessToken } : {
            XAI_OAUTH_TOKEN: credential.accessToken,
            GROK_OAUTH2_ISSUER: credential.issuer ?? GROK_XAI_ISSUER,
            GROK_OAUTH2_CLIENT_ID: credential.clientId ?? GROK_XAI_CLIENT_ID,
          }),
        };
        return { kind: 'environment', env: Object.fromEntries(request.keys.filter(key => key in available).map(key => [key, available[key]])) };
      }
      if (request.kind === 'files') {
        return { kind: 'files', files: Object.fromEntries(request.fileIds.filter(id => id === 'auth.json')
          .map(id => [id, new TextEncoder().encode(serializeGrokSelectedAuth(credential, { nowMs: context.invokedAtMs }))])) };
      }
      if (request.kind !== 'httpHeaders') throw new Error('Unsupported xAI materialization');
      const base = BASES[credential.mode];
      if (!Object.values(BASES).some(value => request.origin === new URL(value).origin)) throw new Error('xAI mode does not permit this origin');
      const available: Readonly<Record<string, string>> = { Authorization: `Bearer ${credential.accessToken}`,
        ...(credential.mode === 'subscription' ? { 'X-XAI-Token-Auth': 'xai-grok-cli' } : {}) };
      const wanted = new Set(request.headerNames.map(name => name.toLowerCase()));
      return { kind: 'httpHeaders', headers: Object.fromEntries(Object.entries(available).filter(([name]) => wanted.has(name.toLowerCase()))),
        ...(credential.expiresAtMs !== undefined ? { expiresAt: credential.expiresAtMs } : {}),
        facts: { mode: credential.mode, usingApi: credential.mode === 'api-key', base } };
    },
  };
}
export const xaiConnectedAccountRuntime = createXaiConnectedAccountRuntime();

// Native import reads the selected Machine's local CLI state. Keep that mode
// on the daemon while the app owns the browser/device/API-key modes.
const { 'native-import': _nativeImport, ...xaiPortableAuthenticationModes } = xaiConnectedAccountRuntime.authentication.modes;
export const xaiPortableConnectedAccountRuntime: ConnectedAccountRuntime = {
  ...xaiConnectedAccountRuntime,
  authentication: { modes: xaiPortableAuthenticationModes },
};
