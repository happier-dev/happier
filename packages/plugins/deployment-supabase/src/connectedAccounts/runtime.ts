import { isPluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { PluginError } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountMaterialization, ConnectedAccountPortableRuntime, ConnectedAccountReadContext, ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

const origin = 'https://api.supabase.com';
type Context = ConnectedAccountAuthenticationContext | ConnectedAccountReadContext;
const diagnostic = (code: string) => ({ code, severity: 'error' as const });
const tokenValid = (token: unknown): token is string => typeof token === 'string' && token.length > 0 && !/\s/u.test(token);
async function probe(token: string, context: Context, signal: AbortSignal) {
  const slug = context.configuration.values.organizationSlug;
  if (typeof slug !== 'string' || !slug.trim()) return { status: 'rejected' as const, diagnostic: diagnostic('supabase_organization_required') };
  const projectRef = context.configuration.values.projectRef;
  if (projectRef !== undefined && (typeof projectRef !== 'string' || !projectRef.trim())) return { status: 'rejected' as const, diagnostic: diagnostic('supabase_project_required') };
  const url = projectRef ? `${origin}/v1/projects/${encodeURIComponent(String(projectRef))}` : `${origin}/v1/organizations`;
  signal.throwIfAborted();
  try {
    // Exact-project PATs need no organization-list permission. Organization
    // discovery is used only when that broader scope was explicitly selected.
    const response = await context.services.http.request({ url, method: 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}` } }, { signal });
    signal.throwIfAborted();
    if (response.status === 401 || response.status === 403 || response.status === 404) return { status: 'rejected' as const, diagnostic: diagnostic(response.status === 401 ? 'supabase_invalid_token' : 'supabase_organization_unavailable') };
    if (response.status !== 200 || response.finalUrl !== url) return { status: 'unavailable' as const, diagnostic: {
      ...diagnostic('supabase_unavailable'), details: {
        failureCause: projectActionFailureCauseV1({ response: { status: response.status } }, 'supabase.verification'),
        ...(response.status === 429 ? { failureClass: 'rateLimit' } : {}),
      },
    } };
    const body: unknown = JSON.parse(new TextDecoder().decode(response.body));
    const value: unknown = projectRef ? body : Array.isArray(body) ? body.find((item: unknown) => item !== null && typeof item === 'object' && 'slug' in item && item.slug === slug) : null;
    if (!value || typeof value !== 'object' || !('name' in value) || typeof value.name !== 'string'
      || (projectRef ? !('ref' in value) || value.ref !== projectRef || !('organization_slug' in value) || value.organization_slug !== slug : !('slug' in value) || value.slug !== slug)) return { status: 'rejected' as const, diagnostic: diagnostic('supabase_scope_mismatch') };
    return { status: 'connected' as const, displayName: value.name, providerIdentity: { accountId: null, email: null, organizationId: slug }, scopes: [] };
  } catch (error) {
    signal.throwIfAborted();
    const failureCause = projectActionFailureCauseV1(error, 'supabase.verification', { allowUnknownErrorCode: isPluginError(error) });
    return withActionFailureDiagnostic({ status: 'unavailable' as const, diagnostic: {
      ...diagnostic(failureCause.errorCode ?? 'action_failed'), details: { failureCause },
    } }, { phase: 'supabase.verification', causeKind: 'native_failure', error: new Error(failureCause.errorClass) });
  }
}
async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }) {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    if (!tokenValid(token)) return { status: 'reconnectRequired' as const, diagnostic: diagnostic('supabase_invalid_token') };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired' as const, diagnostic: result.diagnostic } : result;
  } catch (error) {
    signal.throwIfAborted();
    const failureCause = projectActionFailureCauseV1(error, 'supabase.health', { allowUnknownErrorCode: isPluginError(error) });
    return withActionFailureDiagnostic({ status: 'unavailable' as const, diagnostic: {
      ...diagnostic(failureCause.errorCode ?? 'action_failed'), details: { failureCause },
    } }, { phase: 'supabase.health', causeKind: 'native_failure', error: new Error(failureCause.errorClass) });
  }
}
const materialize: NonNullable<ConnectedAccountPortableRuntime['materialize']> = async (request, context, options): Promise<ConnectedAccountMaterialization> => {
  const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || request.origin !== origin || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new PluginError({ code: 'credential_unavailable' });
  if (request.headerNames.length === 0) return { kind: 'httpHeaders', headers: {} };
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!tokenValid(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
  } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
};

export const supabaseConnectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal;
    const token = input.fields.token;
    if (!tokenValid(token)) return { status: 'rejected', diagnostic: diagnostic('supabase_invalid_token') };
    const result = await probe(token, context, signal);
    if (result.status !== 'connected') return result;
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch { signal.throwIfAborted(); return { status: 'unavailable', diagnostic: diagnostic('supabase_credential_storage_unavailable') }; }
    return result;
  } } } },
  status: health,
  refresh: health,
  async revoke() { return { status: 'remoteUnsupported', diagnostic: diagnostic('supabase_manual_revoke_required') }; },
  materialize,
};

export const supabasePortableRuntime: ConnectedAccountPortableRuntime = {
  authentication: supabaseConnectedAccountRuntime.authentication,
  materialize,
};
