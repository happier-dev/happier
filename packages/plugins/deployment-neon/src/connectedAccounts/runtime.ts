import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountMaterialization, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

const origin = 'https://console.neon.tech';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
const diagnostic = (code: string) => ({ code, severity: 'error' as const, message: code });
function validToken(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/u.test(value); }
async function probe(token: string, context: Context, signal: AbortSignal) {
  const { organizationId, projectId } = context.configuration.values;
  if (typeof organizationId !== 'string' || !organizationId || (projectId !== undefined && (typeof projectId !== 'string' || !projectId))) {
    return { status: 'rejected' as const, diagnostic: diagnostic('neon_invalid_configuration') };
  }
  const url = `${origin}/api/v2/${projectId ? `projects/${encodeURIComponent(projectId)}` : `organizations/${encodeURIComponent(organizationId)}`}`;
  signal.throwIfAborted();
  try {
    const response = await context.services.http.request({ url, method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}` } }, { signal });
    signal.throwIfAborted();
    if (response.status === 401 || response.status === 403 || response.status === 404) return { status: 'rejected' as const,
      diagnostic: diagnostic(response.status === 401 ? 'neon_invalid_token' : 'neon_scope_unavailable') };
    if (response.status !== 200 || response.finalUrl !== url) return { status: 'unavailable' as const, diagnostic: diagnostic('neon_unavailable') };
    const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
    const scope: unknown = projectId && body && typeof body === 'object' && 'project' in body ? body.project : body;
    if (!scope || typeof scope !== 'object' || !('id' in scope) || scope.id !== (projectId ?? organizationId)
      || !('name' in scope) || typeof scope.name !== 'string'
      || projectId && (!('org_id' in scope) || scope.org_id !== organizationId)) {
      return { status: 'rejected' as const, diagnostic: diagnostic('neon_scope_mismatch') };
    }
    return { status: 'connected' as const, displayName: scope.name,
      providerIdentity: { accountId: null, email: null, organizationId }, scopes: [] };
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable' as const, diagnostic: diagnostic('neon_unavailable') };
  }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    if (!validToken(token)) return { status: 'reconnectRequired' as const, diagnostic: diagnostic('neon_invalid_token') };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired' as const, diagnostic: result.diagnostic } : result;
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable' as const, diagnostic: diagnostic('neon_unavailable') };
  }
}
const materialize: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options): Promise<ConnectedAccountMaterialization> => {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || request.origin !== origin || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) {
    throw new PluginError({ code: 'credential_unavailable' });
  }
  if (!request.headerNames.length) return { kind: 'httpHeaders', headers: {} };
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
  } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
};

export const neonConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    const token = input.fields.token;
    if (!validToken(token)) return { status: 'rejected', diagnostic: diagnostic('neon_invalid_token') };
    const result = await probe(token, context, signal);
    if (result.status !== 'connected') return result;
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch { signal.throwIfAborted(); return { status: 'unavailable', diagnostic: diagnostic('neon_credential_storage_unavailable') }; }
    return result;
  } } } },
  status: health, refresh: health,
  async revoke() { return { status: 'remoteUnsupported', diagnostic: diagnostic('neon_manual_revoke_required') }; },
  materialize,
};

export const neonPortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: neonConnectedAccountRuntime.authentication,
  materialize,
};
