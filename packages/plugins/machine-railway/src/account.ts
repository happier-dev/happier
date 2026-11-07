import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountReadContext, ConnectedAccountPortableReadContext, ConnectedAccountPortableRuntime, ConnectedAccountRuntime, ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

export const ACCOUNT_ID = 'railway-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = ['https://backboard.railway.com'] as const;
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'Railway API access could not be confirmed.' };
const validToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !/\s/u.test(value);
type HttpContext = Readonly<{ signal: AbortSignal; services: Readonly<{ http: Pick<HttpService, 'request'> }> }>;

/** The host captures the selected Account purpose; no bearer enters role arguments or guest files. */
export function nativeFetch(context: HttpContext, token?: string): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: ORIGINS, headerName: 'authorization',
    credential: token === undefined ? undefined : { 'authorization': `Bearer ${token}` },
  });
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, signal: AbortSignal) {
  try {
    const response = await nativeFetch(context, token)('https://backboard.railway.com/graphql/v2', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'query { me { id name email } }' }),
    });
    if (response.status === 401 || response.status === 403) return { status: 'rejected' as const, diagnostic };
    if (response.status !== 200) return { status: 'unavailable' as const, diagnostic };
    const value: unknown = await response.json();
    if (!object(value)) return { status: 'unavailable' as const, diagnostic };
    if ('errors' in value && (!Array.isArray(value.errors) || value.errors.length > 0)) {
      const denied = Array.isArray(value.errors) && value.errors.some(error => object(error)
        && (object(error.extensions) && ['UNAUTHENTICATED', 'FORBIDDEN'].includes(String(error.extensions.code))
          || typeof error.message === 'string' && /^(?:not authorized|unauthorized|invalid token)[.!]?$/iu.test(error.message.trim())));
      return denied ? { status: 'rejected' as const, diagnostic } : { status: 'unavailable' as const, diagnostic };
    }
    const me = object(value.data) ? value.data.me : undefined;
    if (!object(me) || typeof me.id !== 'string' || !me.id.trim()
      || me.name !== null && typeof me.name !== 'string'
      || me.email !== null && (typeof me.email !== 'string' || !me.email.trim())) return { status: 'unavailable' as const, diagnostic };
    return { status: 'connected' as const, displayName: me.name?.trim() || me.email || me.id,
      providerIdentity: { accountId: me.id, email: me.email, organizationId: null }, scopes: [] };
  } catch { signal.throwIfAborted(); return { status: 'unavailable' as const, diagnostic }; }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    if (!validToken(token)) return { status: 'reconnectRequired' as const, diagnostic };
    const result = await confirm(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired' as const, diagnostic } : result;
  } catch { signal.throwIfAborted(); return { status: 'unavailable' as const, diagnostic }; }
}
async function materialize(request: Parameters<ConnectedAccountRuntime['materialize']>[0], context: ConnectedAccountPortableReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountMaterialization> {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || !ORIGINS.some(origin => origin === request.origin)
    || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new PluginError({ code: 'credential_unavailable' });
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: request.headerNames.length ? { authorization: `Bearer ${token}` } : {} };
  } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
}
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    signal.throwIfAborted();
    const supplied = input.fields.token, token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected', diagnostic };
    const result = await confirm(token, context, signal);
    if (result.status !== 'connected') return result;
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch { signal.throwIfAborted(); return { status: 'unavailable', diagnostic }; }
    return result;
  } } } },
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported', diagnostic: { ...diagnostic, message: 'Revoke the Railway API token in the Railway dashboard.' } }; },
  materialize,
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = { authentication: connectedAccountRuntime.authentication, materialize };
export function activate(api: PluginAccountApi): void { api.connectedAccounts.register(ACCOUNT_ID, connectedAccountPortableRuntime); }
