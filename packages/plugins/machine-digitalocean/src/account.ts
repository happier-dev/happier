import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createDigitalOceanProvider } from './machine/provider.js';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const ACCOUNT_ID = 'digitalocean-account';
const origins: readonly string[] = ["https://api.digitalocean.com"];
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'DigitalOcean API access could not be confirmed.' };
function validToken(value: string | null | undefined) { return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value); }

/** Vendor IO always goes through host HTTP and the captured Action credential. */
export function nativeFetch(context: Readonly<{ signal: AbortSignal; services: Readonly<{ http: Pick<HttpService, 'request'> }> }>, credential?: string | Readonly<Record<string, string>>): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: origins, headerName: 'authorization',
    credential: typeof credential === 'string' ? { authorization: `Bearer ${credential}` } : credential,
    methods: ['GET', 'POST', 'DELETE'],
  });
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
