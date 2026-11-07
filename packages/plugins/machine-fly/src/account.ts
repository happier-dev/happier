import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { ConnectedAccountRuntime, ConnectedAccountAuthenticationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { createFlyNativeClient } from './machine/nativeClient.js';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const ACCOUNT_ID = 'fly-account';
const origins: readonly string[] = ["https://api.machines.dev","https://api.fly.io"];
const diagnostic = { code: 'credential_unavailable', severity: 'error' as const, message: 'Fly API access could not be confirmed.' };
function validToken(value: string | null | undefined) { return typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value); }
type NativeHttpContext = Readonly<{
  signal: AbortSignal;
  services: Readonly<{
    http: PluginAccountActionContext['services']['http'];
  }>;
}>;

/** The host captures the purpose once; vendor HTTP never exposes its bearer to a role. */
export function nativeFetch(context: NativeHttpContext, token?: string): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: origins, headerName: 'authorization',
    credential: token === undefined ? undefined : { 'authorization': `Bearer ${token}` },
    methods: ['GET', 'POST', 'DELETE'],
  });
}
async function confirm(token: string, context: ConnectedAccountAuthenticationContext | ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  try {
    const organizationSlug = context.configuration.values.organizationSlug;
    if (typeof organizationSlug !== 'string' || !organizationSlug.trim()) return 'reconnectRequired' as const;
    const result = await createFlyNativeClient('host-bound', nativeFetch(context, token), { signal: options?.signal ?? context.signal }).check({ organizationSlug });
    return result.available ? 'connected' as const : result.code === 'authorization' ? 'reconnectRequired' as const : 'unavailable' as const;
  } catch (error) {
    if ((options?.signal ?? context.signal).aborted) throw error;
    return 'unavailable' as const;
  }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const token = await context.credentials.get('token', options);
  const status = validToken(token) ? await confirm(token!, context, options) : 'reconnectRequired' as const;
  return status === 'connected' ? { status, displayName: 'Fly' } : { status, diagnostic };
}
export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const token = input.fields.token?.trim();
    if (!validToken(token)) return { status: 'rejected', diagnostic };
    const status = await confirm(token!, context, options);
    if (status === 'unavailable') return { status: 'unavailable', diagnostic };
    if (status !== 'connected') return { status: 'rejected', diagnostic };
    await context.attemptCredentials.set('token', token!, options);
    return { status: 'connected', displayName: 'Fly', scopes: [] };
  } } } },
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported' }; },
  async materialize(request, context, options) {
    if (request.kind === 'environment' && request.keys.every(key => key === 'FLY_ORGANIZATION')) {
      const organizationSlug = context.configuration.values.organizationSlug;
      if (typeof organizationSlug !== 'string' || !organizationSlug.trim()) throw new Error('credential_unavailable');
      return { kind: 'environment', env: { FLY_ORGANIZATION: organizationSlug } };
    }
    if (request.kind !== 'httpHeaders' || !origins.includes(request.origin)
      || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new Error('credential_unavailable');
    const token = await context.credentials.get('token', options);
    if (!validToken(token)) throw new Error('credential_unavailable');
    return { kind: 'httpHeaders', headers: { Authorization: `Bearer ${token}` } };
  },
};
