import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createBoatNativeClient } from './machine/nativeClient.js';
import { BoatNativeError } from './machine/schemas.js';

export const ACCOUNT_ID = 'boat-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
const ORIGIN = 'https://boat.dev';
export const BOAT_NATIVE_HTTP_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'Boat API access could not be confirmed.' };
const validToken = (value: string | null | undefined) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);

type HttpContext = Readonly<{ signal: AbortSignal; services: Readonly<{ http: Pick<HttpService, 'request'> }> }>;

export function nativeFetch(context: HttpContext, token?: string): typeof globalThis.fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: [ORIGIN], headerName: 'authorization',
    credential: token === undefined ? undefined : { 'authorization': `Bearer ${token}` },
    methods: BOAT_NATIVE_HTTP_METHODS,
  });
}

async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  try {
    await createBoatNativeClient({ fetch: nativeFetch(context, token), signal: options?.signal ?? context.signal }).check();
    return 'connected' as const;
  } catch (error) {
    if ((options?.signal ?? context.signal).aborted) throw error;
    return error instanceof BoatNativeError && error.code === 'native_authorization_failed'
      ? 'reconnectRequired' as const : 'unavailable' as const;
  }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const token = await context.credentials.get('token', options);
  const status = validToken(token) ? await confirm(token!, context, options) : 'reconnectRequired' as const;
  return status === 'connected' ? { status, displayName: 'Boat' } : { status, diagnostic };
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const token = input.fields.token?.trim();
    if (!validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token!, context, options);
    if (status === 'unavailable') return { status, diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set('token', token!, options);
    return { status: 'connected', displayName: 'Boat', scopes: [] };
  } } } },
  status: health,
  refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind !== 'httpHeaders' || request.origin !== ORIGIN
      || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('credential_unavailable');
    const token = await context.credentials.get('token', options);
    if (!validToken(token)) throw new Error('credential_unavailable');
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};
