import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountAuthCompletionResult, ConnectedAccountHealthResult,
  ConnectedAccountPortableReadContext, ConnectedAccountRuntime, ConnectedAccountPortableRuntime,
  ConnectedAccountReadContext, ConnectedAccountMaterializationRequest, ConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const ACCOUNT_ID = 'superserve-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
export const API_ORIGIN = 'https://api.superserve.ai';
export const GUEST_ORIGIN = 'https://sandbox.superserve.ai';
const origin = API_ORIGIN;
const diagnostic = (code: string, message: string) => ({ code, severity: 'error' as const, message });
const validToken = (token: unknown): token is string => typeof token === 'string' && token.length > 0 && !/\s/u.test(token);
const operationSignal = (context: { signal: AbortSignal }, signal?: AbortSignal) => signal ? AbortSignal.any([context.signal, signal]) : context.signal;
type ProbeContext = Pick<ConnectedAccountAuthenticationContext, 'signal' | 'services'>;

/** A read proves key access, without inventing write scopes or allocating a sandbox. */
async function probe(token: string, context: ProbeContext, signal: AbortSignal): Promise<Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>> {
  signal.throwIfAborted();
  const url = origin + '/sandboxes';
  try {
    const response = await context.services.http.request({ url, method: 'GET', headers: { 'x-api-key': token }, redirect: 'error' }, { signal });
    signal.throwIfAborted();
    if (response.finalUrl !== url || response.status >= 300 && response.status < 400) throw new Error('superserve_unavailable');
    if (response.status === 401 || response.status === 403) return { status: 'rejected', diagnostic: diagnostic('superserve_invalid_token', 'The Superserve API key is invalid or cannot access this team. Reconnect with an API key from the Superserve dashboard.') };
    if (response.status !== 200 || !Array.isArray(JSON.parse(new TextDecoder().decode(response.body)))) throw new Error('superserve_unavailable');
    return { status: 'connected', displayName: 'Superserve', scopes: [] };
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('superserve_unavailable', 'Superserve could not verify the API key. Try again.') };
  }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) return { status: 'reconnectRequired', diagnostic: diagnostic('superserve_invalid_token', 'Reconnect Superserve with an API key.') };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('superserve_unavailable', 'The Superserve connection could not be checked.') };
  }
}

async function materialize(request: ConnectedAccountMaterializationRequest, context: ConnectedAccountPortableReadContext,
  options?: { signal?: AbortSignal }): Promise<ConnectedAccountMaterialization> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || request.origin !== origin || request.headerNames.some(name => name.toLowerCase() !== 'x-api-key')) throw new PluginError({ code: 'credential_unavailable' });
  if (!request.headerNames.length) return { kind: 'httpHeaders', headers: {} };
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: { 'x-api-key': token } };
  } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected', diagnostic: diagnostic('superserve_invalid_token', 'Enter an Superserve API key.') };
    const result = await probe(token, context, signal);
    if (result.status !== 'connected') return result;
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch { signal.throwIfAborted(); return { status: 'unavailable', diagnostic: diagnostic('superserve_credential_storage_unavailable', 'The verified Superserve key could not be saved. Try again.') }; }
    signal.throwIfAborted();
    return result;
  } } } },
  status: health,
  refresh: health,
  async revoke(context, options) {
    operationSignal(context, options?.signal).throwIfAborted();
    return { status: 'remoteUnsupported', diagnostic: diagnostic('superserve_manual_revoke_required', 'Revoke the API key in the Superserve dashboard.') };
  },
  materialize,
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = { authentication: connectedAccountRuntime.authentication, materialize: connectedAccountRuntime.materialize };
export function activate(api: PluginAccountApi) { api.connectedAccounts.register(ACCOUNT_ID, connectedAccountPortableRuntime); }
