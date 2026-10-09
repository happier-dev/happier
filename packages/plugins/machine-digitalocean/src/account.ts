import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpMethod } from '@happier-dev/plugin-sdk/http';
import { createDigitalOceanProvider } from './machine/provider.js';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const ACCOUNT_ID = 'digitalocean-account';
const origins: readonly string[] = ["https://api.digitalocean.com"];
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'DigitalOcean API access could not be confirmed.' };
function validToken(value: string | null | undefined) { return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value); }

/** Vendor IO always goes through host HTTP and the captured Action credential. */
export function nativeFetch(context: Pick<PluginInvocationContext, 'services' | 'signal'>, token?: string): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const origin = new URL(url).origin;
    if (!origins.includes(origin)) throw new Error('provider_unavailable');
    const method = init?.method ?? 'GET';
    if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('invalid_request');
    const signal = init?.signal ?? context.signal;
    const material = token === undefined
      ? await context.services.connectedAccounts.materialize(ACCOUNT_PURPOSE,
          { kind: 'httpHeaders', origin, headerNames: ['authorization'] }, { signal })
      : { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}` } };
    if (material.kind !== 'httpHeaders') throw new Error('credential_unavailable');
    const authorization = new Headers(material.headers).get('authorization');
    if (!authorization) throw new Error('credential_unavailable');
    const headers = new Headers(init?.headers);
    headers.set('Authorization', authorization);
    const response = await context.services.http.request({ url, method: method as HttpMethod,
      headers: Object.fromEntries(headers.entries()), redirect: 'error',
      ...(init?.body === undefined ? {} : { body: new TextEncoder().encode(String(init.body)) }),
    }, { signal });
    if (response.finalUrl !== url) throw new Error('provider_unavailable');
    return new Response(response.status === 204 ? null : new Uint8Array(response.body), { status: response.status, headers: response.headers });
  };
}
async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  try {
    const result = await createDigitalOceanProvider({ token: 'host-bound', fetch: nativeFetch(context, token), signal: options?.signal ?? context.signal }).check();
    return result.available ? 'connected' as const : result.code === 'authorization' || result.code === 'account-unavailable' ? 'reconnectRequired' as const : 'unavailable' as const;
  } catch (error) {
    if ((options?.signal ?? context.signal).aborted) throw error;
    return 'unavailable' as const;
  }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const token = await context.credentials.get('token', options);
  const status = validToken(token) ? await confirm(token!, context, options) : 'reconnectRequired' as const;
  return status === 'connected' ? { status, displayName: 'DigitalOcean' } : { status, diagnostic };
}
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const token = input.fields.token?.trim();
    if (!validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token!, context, options);
    if (status === 'unavailable') return { status: 'unavailable', diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set('token', token!, options);
    return { status: 'connected', displayName: 'DigitalOcean', scopes: [] };
  } } } },
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'httpHeaders' || !origins.includes(request.origin)
      || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('credential_unavailable');
    const token = await context.credentials.get('token', options);
    if (!validToken(token)) throw new Error('credential_unavailable');
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};
