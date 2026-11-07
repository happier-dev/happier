import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountPortableRuntime, ConnectedAccountMaterializationRequest } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { createHetznerProvider } from './machine/provider.js';
import { HetznerNativeError } from './machine/schemas.js';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const ACCOUNT_ID = 'hetzner-account';
const origins: readonly string[] = ["https://api.hetzner.cloud"];
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'Hetzner API access could not be confirmed.' };
function validToken(value: string | null | undefined) { return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value); }

type HttpContext = Readonly<{ signal: AbortSignal; services: Readonly<{ http: Pick<HttpService, 'request'> }> }>;

/** HTTP uses the host-captured purpose or its invocation-scoped materialization. */
export function nativeFetch(context: HttpContext, credential?: string | Readonly<Record<string, string>>): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: origins, headerName: 'authorization',
    credential: typeof credential === 'string' ? { authorization: `Bearer ${credential}` } : credential,
    methods: ['GET', 'POST', 'DELETE'],
  });
}
async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  try {
    await createHetznerProvider({ token: 'host-bound', fetch: nativeFetch(context, token), signal: options?.signal ?? context.signal }).check();
    return 'connected' as const;
  } catch (error) {
    if ((options?.signal ?? context.signal).aborted) throw error;
    return error instanceof HetznerNativeError && error.code === 'native_authorization_failed' ? 'reconnectRequired' as const : 'unavailable' as const;
  }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const token = await context.credentials.get('token', options);
  const status = validToken(token) ? await confirm(token!, context, options) : 'reconnectRequired' as const;
  return status === 'connected' ? { status, displayName: 'Hetzner' } : { status, diagnostic };
}
const authentication: ConnectedAccountRuntime['authentication'] = { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const token = input.fields.token?.trim();
    if (!validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token!, context, options);
    if (status === 'unavailable') return { status: 'unavailable', diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set('token', token!, options);
    return { status: 'connected', displayName: 'Hetzner', scopes: [] };
  } } } };
async function materialize(request: ConnectedAccountMaterializationRequest,
  context: Pick<ConnectedAccountReadContext, 'credentials'>, options?: { signal?: AbortSignal }) {
  if (request.kind !== 'httpHeaders' || !origins.includes(request.origin)
    || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('credential_unavailable');
  const token = await context.credentials.get('token', options);
  if (!validToken(token)) throw new Error('credential_unavailable');
  return { kind: 'httpHeaders' as const, headers: { Authorization: `Bearer ${token}` } };
}
export const connectedAccountPortableRuntime = { authentication, materialize } satisfies ConnectedAccountPortableRuntime;
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication, materialize,
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
};
