import {
  parseConnectedAccountTokenEndpointFailure,
  requestDeviceGrantStep,
  type ConnectedAccountAuthenticationContext,
  type ConnectedAccountAuthCompletionResult,
  type ConnectedAccountRuntime,
  type ConnectedAccountPortableRuntime,
  type ConnectedAccountMaterialization,
  type ConnectedAccountMaterializationRequest,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { z } from 'zod';
import { fetchKimiQuota } from './quota.js';

export const KIMI_OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
export const KIMI_ACCESS_TOKEN_ENV = 'HAPPIER_KIMI_ACCESS_TOKEN';
type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
type MaterializationContext = Pick<ReadContext, 'credentials' | 'signal' | 'invokedAtMs'> & { services: Pick<ReadContext['services'], 'http'> };
const regions = {
  cn: { apiBase: 'https://api.kimi.com/coding/v1', authBase: 'https://auth.kimi.com' },
  global: { apiBase: 'https://api.kimi.ai/coding/v1', authBase: 'https://auth.kimi.ai' },
} as const;
function diagnostic(code: string) {
  return { code, message: 'Kimi account operation could not complete.', severity: 'error' as const };
}
export async function resolveKimiInstallId(context: Pick<ConnectedAccountAuthenticationContext, 'services'>): Promise<string> {
  return context.services.storage.daemon.transaction(async store => {
    const existing = await store.get('kimi-device-id');
    if (typeof existing === 'string' && existing) return existing;
    const id = crypto.randomUUID();
    await store.set('kimi-device-id', id);
    return id;
  });
}
async function selectedBase(context: Pick<ReadContext, 'credentials' | 'configuration'>): Promise<string> {
  const stored = await context.credentials.get('apiBase');
  if (stored) return stored;
  return context.configuration.values.region === 'global' ? regions.global.apiBase : regions.cn.apiBase;
}

const manualMode = { kind: 'manual', async complete(input, context, options) {
  const token = input.fields.token?.trim();
  if (!token) return { status: 'rejected', diagnostic: diagnostic('kimi_key_required') };
  const global = context.configuration.values.region === 'global';
  const platform = context.configuration.values.apiKind === 'platform';
  const apiBase = platform ? (global ? 'https://api.moonshot.ai/v1' : 'https://api.moonshot.cn/v1') : (global ? regions.global.apiBase : regions.cn.apiBase);
  for (const [key, value] of Object.entries({ accessToken: token, credentialKind: 'token', apiBase, apiKind: platform ? 'platform' : 'code' })) await context.attemptCredentials.set(key, value, options);
  return { status: 'connected', credentialKind: 'token', displayName: platform ? 'Moonshot platform API key' : 'Kimi Code API key', scopes: [] };
} } satisfies ConnectedAccountPortableRuntime['authentication']['modes'][string];

export async function materializeKimiCredentials(request: ConnectedAccountMaterializationRequest, context: MaterializationContext, apiBase: string,
  options?: { signal?: AbortSignal; existingFiles?: Readonly<Record<string, Uint8Array>> }): Promise<ConnectedAccountMaterialization> {
  const token = await context.credentials.get('accessToken', options);
  if (!token) throw Object.assign(new Error('Kimi credentials are unavailable'), { code: 'kimi_credentials_unavailable' });
  if (request.kind === 'environment') return { kind: 'environment', env: request.keys.includes(KIMI_ACCESS_TOKEN_ENV) ? { [KIMI_ACCESS_TOKEN_ENV]: token } : {} };
  const deviceId = await context.credentials.get('deviceId', options);
  if (request.kind === 'files') {
    if (!request.fileIds.includes('config.toml')) return { kind: 'files', files: {} };
    const response = await context.services.http.request({ url: `${apiBase}/models`, method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Msh-Device-Id': deviceId } : {}) } }, { signal: options?.signal ?? context.signal });
    if (response.status !== 200) throw Object.assign(new Error('Kimi account models are unavailable'), { code: 'model_selection_required' });
    const { materializeKimiConfig } = await import('./nativeConfig.js');
    return { kind: 'files', files: { 'config.toml': await materializeKimiConfig({
      modelResponse: JSON.parse(new TextDecoder().decode(response.body)), apiBase, accessToken: token,
      selectedConfig: await context.credentials.get('nativeConfig', options), existingConfig: options?.existingFiles?.['config.toml'],
    }) } };
  }
  if (new URL(apiBase).origin !== request.origin) throw new Error('Kimi selected account origin does not match');
  const headers: Record<string, string> = {};
  for (const name of request.headerNames) {
    if (name.toLowerCase() === 'authorization') headers.Authorization = `Bearer ${token}`;
    else if (name.toLowerCase() === 'x-msh-device-id') { if (deviceId) headers['X-Msh-Device-Id'] = deviceId; }
    else throw new Error('Unsupported Kimi request header');
  }
  const expiry = await context.credentials.get('expiresAtMs', options);
  return { kind: 'httpHeaders', headers, facts: { domain: new URL(apiBase).hostname.replace(/^api\./u, ''), apiBase, ...(deviceId ? { deviceId } : {}) }, ...(expiry ? { expiresAt: Number(expiry) } : {}) };
}

export const kimiPortableAccountRuntime: ConnectedAccountPortableRuntime = {
  authentication: { modes: { 'api-key': manualMode } },
  async materialize(request, context, options) { return materializeKimiCredentials(request, context, await selectedBase(context), options); },
};
async function health(context: ReadContext) {
  const kind = await context.credentials.get('credentialKind') === 'oauth' ? 'oauth' as const : 'token' as const;
  const token = await context.credentials.get('accessToken');
  if (!token) return { status: 'unavailable' as const, diagnostic: diagnostic('kimi_credentials_unavailable') };
  const expiry = await context.credentials.get('expiresAtMs');
  return { status: expiry && Number(expiry) <= context.invokedAtMs ? 'expired' as const : 'connected' as const,
    credentialKind: kind, ...(expiry ? { expiresAt: Number(expiry) } : {}) };
}

/** Vendor adapters only; the host owns attempts, refresh scheduling and settlement. */
export function createKimiConnectedAccountRuntime(): ConnectedAccountRuntime {
  return {
    authentication: { modes: {
      device: { kind: 'oauthDeviceCode', async begin(context, options) {
        const region = context.configuration.values.region === 'global' ? regions.global : regions.cn;
        const deviceId = await resolveKimiInstallId(context);
        const result = await requestDeviceGrantStep({ http: context.services.http, headers: { 'X-Msh-Device-Id': deviceId }, url: `${region.authBase}/api/oauth/device_authorization`,
          fields: { client_id: KIMI_OAUTH_CLIENT_ID }, pollIntervalMs: 0,
          async parseSuccess(body) {
            const result = z.object({ device_code: z.string().min(1), user_code: z.string().min(1), verification_uri: z.url(), verification_uri_complete: z.url().optional(), expires_in: z.number().positive(), interval: z.number().positive() }).safeParse(body);
            if (!result.success) return { status: 'unavailable' as const, diagnostic: diagnostic('kimi_device_response_invalid') };
            const data = result.data;
            for (const [key, value] of Object.entries({ deviceCode: data.device_code, deviceId, devicePollIntervalMs: String(data.interval * 1000), apiBase: region.apiBase })) await context.attemptCredentials.set(key, value, options);
            return { status: 'awaitingDeviceAuthorization' as const, verificationUri: data.verification_uri,
              ...(data.verification_uri_complete ? { verificationUriComplete: data.verification_uri_complete } : {}),
              userCode: data.user_code, pollIntervalMs: data.interval * 1000, expiresAtMs: context.invokedAtMs + data.expires_in * 1000 };
          },
        }, { signal: options?.signal ?? context.signal });
        return result.status === 'pending' ? { status: 'unavailable', diagnostic: diagnostic('kimi_device_response_invalid') } : result;
      }, async poll(context, options) {
        const code = await context.attemptCredentials.get('deviceCode', options);
        const deviceId = await context.attemptCredentials.get('deviceId', options);
        const apiBase = await context.attemptCredentials.get('apiBase', options);
        const interval = Number(await context.attemptCredentials.get('devicePollIntervalMs', options));
        if (!code || !deviceId || !apiBase || !interval) return { status: 'unavailable', diagnostic: diagnostic('kimi_device_attempt_unavailable') };
        const authBase = apiBase === regions.global.apiBase ? regions.global.authBase : regions.cn.authBase;
        const result = await requestDeviceGrantStep<ConnectedAccountAuthCompletionResult>({ http: context.services.http, headers: { 'X-Msh-Device-Id': deviceId }, url: `${authBase}/api/oauth/token`,
          fields: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: KIMI_OAUTH_CLIENT_ID, device_code: code }, pollIntervalMs: interval,
          async parseSuccess(body) {
            const parsed = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.coerce.number().positive(), scope: z.string().optional(), token_type: z.string().optional() }).safeParse(body);
            if (!parsed.success) return { status: 'unavailable', diagnostic: diagnostic('kimi_token_response_invalid') };
            const token = parsed.data;
            for (const [key, value] of Object.entries({ accessToken: token.access_token, refreshToken: token.refresh_token, credentialKind: 'oauth', apiKind: 'code', oauthHost: authBase,
              expiresAtMs: String(context.invokedAtMs + token.expires_in * 1000), ...(token.scope === undefined ? {} : { scope: token.scope }), ...(token.token_type === undefined ? {} : { tokenType: token.token_type }) })) await context.attemptCredentials.set(key, value, options);
            await context.attemptCredentials.delete('deviceCode', options);
            await context.attemptCredentials.delete('devicePollIntervalMs', options);
            return { status: 'connected', credentialKind: 'oauth', displayName: 'Kimi Code', scopes: token.scope?.split(' ').filter(Boolean) ?? [] };
          },
        }, { signal: options?.signal ?? context.signal });
        if (result.status === 'pending') await context.attemptCredentials.set('devicePollIntervalMs', String(result.retryAfterMs), options);
        return result;
      }, async cancel(context) {
        await context.attemptCredentials.delete('deviceCode');
        await context.attemptCredentials.delete('devicePollIntervalMs');
      } },
      'api-key': manualMode,
    } },
    async status(context) { return health(context); },
    async enrichCredentialContext(context, options) {
      if (await context.credentials.get('apiKind', options) === 'platform') return { status: 'unavailable', diagnostic: diagnostic('kimi_identity_unavailable') };
      const token = await context.credentials.get('accessToken', options);
      if (!token) return { status: 'unavailable', diagnostic: diagnostic('kimi_credentials_unavailable') };
      const deviceId = await context.credentials.get('deviceId', options);
      const signal = options?.signal ?? context.signal;
      try {
        const response = await context.services.http.request({ url: `${await selectedBase(context)}/me`, method: 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Msh-Device-Id': deviceId } : {}) } }, { signal });
        signal.throwIfAborted();
        if (response.status !== 200) return { status: 'unavailable', diagnostic: { ...diagnostic('kimi_identity_unavailable'), details: { providerHttpStatus: response.status } } };
        const identity = z.object({ user_id: z.string().min(1), email: z.string().optional(), nickname: z.string().optional() }).safeParse(JSON.parse(new TextDecoder().decode(response.body)));
        if (!identity.success) return { status: 'unavailable', diagnostic: diagnostic('kimi_identity_response_invalid') };
        const data = identity.data;
        return { ...await health(context), providerIdentity: { accountId: data.user_id, ...(data.email ? { email: data.email } : {}) }, displayName: data.nickname || data.email || 'Kimi Code' };
      } catch {
        signal.throwIfAborted();
        return { status: 'unavailable', diagnostic: diagnostic('kimi_identity_unavailable') };
      }
    },
    async refresh(context, options) {
      if (await context.credentials.get('credentialKind', options) !== 'oauth') return health(context);
      const refreshToken = await context.credentials.get('refreshToken', options);
      if (!refreshToken) return { status: 'unavailable', diagnostic: diagnostic('kimi_refresh_unavailable') };
      const apiBase = await selectedBase(context);
      const authBase = await context.credentials.get('oauthHost', options) ?? (apiBase === regions.global.apiBase ? regions.global.authBase : regions.cn.authBase);
      let response;
      const deviceId = await context.credentials.get('deviceId', options);
      try {
        response = await context.services.http.request({ url: `${authBase}/api/oauth/token`, method: 'POST',
          redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(deviceId ? { 'X-Msh-Device-Id': deviceId } : {}) },
          body: new TextEncoder().encode(new URLSearchParams({ grant_type: 'refresh_token', client_id: KIMI_OAUTH_CLIENT_ID, refresh_token: refreshToken }).toString()),
        }, { signal: options?.signal ?? context.signal });
      } catch (error) {
        (options?.signal ?? context.signal).throwIfAborted();
        return { status: 'outcomeUnknown', diagnostic: diagnostic('kimi_refresh_transport_unavailable') };
      }
      if (response.status < 200 || response.status >= 300) {
        const failure = parseConnectedAccountTokenEndpointFailure(response);
        return { status: failure.kind === 'invalid_grant' ? 'reconnectRequired' : 'outcomeUnknown',
          diagnostic: { ...diagnostic('kimi_refresh_failed'), details: { providerHttpStatus: response.status, credentialRefreshFailureKind: failure.kind, ...(failure.providerErrorCode ? { providerErrorCode: failure.providerErrorCode } : {}) } } };
      }
      const schema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.coerce.number().finite().positive(), scope: z.string().optional(), token_type: z.string().optional() });
      let data;
      try { data = schema.parse(JSON.parse(new TextDecoder().decode(response.body))); }
      catch { return { status: 'outcomeUnknown', diagnostic: diagnostic('kimi_token_response_invalid') }; }
      const expiresAt = context.invokedAtMs + data.expires_in * 1000;
      await context.stagedCredentials.set('accessToken', data.access_token, options);
      await context.stagedCredentials.set('refreshToken', data.refresh_token ?? refreshToken, options);
      await context.stagedCredentials.set('expiresAtMs', String(expiresAt), options);
      if (data.scope !== undefined) await context.stagedCredentials.set('scope', data.scope, options);
      if (data.token_type !== undefined) await context.stagedCredentials.set('tokenType', data.token_type, options);
      return { status: 'connected', credentialKind: 'oauth', expiresAt };
    },
    async revoke() { return { status: 'remoteUnsupported' }; },
    async quota(context, options) {
      if (await context.credentials.get('apiKind', options) === 'platform') throw Object.assign(new Error('Kimi subscription usage is unavailable for a platform key'), { code: 'kimi_usage_unavailable' });
      const token = await context.credentials.get('accessToken', options);
      if (!token) throw new Error('Kimi credentials are unavailable');
      const deviceId = await context.credentials.get('deviceId', options);
      return fetchKimiQuota({ http: context.services.http, baseUrl: await selectedBase(context), headers: { Authorization: `Bearer ${token}`, ...(deviceId ? { 'X-Msh-Device-Id': deviceId } : {}) }, observedAtMs: context.invokedAtMs, signal: options?.signal ?? context.signal });
    },
    async materialize(request, context, options) {
      return materializeKimiCredentials(request, context, await selectedBase(context), options);
    },
  };
}
