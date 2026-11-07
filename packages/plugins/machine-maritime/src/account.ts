import { PluginError, type PluginAccountApi } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountAuthCompletionResult, ConnectedAccountHealthResult,
  ConnectedAccountPortableReadContext, ConnectedAccountRuntime, ConnectedAccountPortableRuntime,
  ConnectedAccountReadContext, ConnectedAccountMaterializationRequest, ConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const ACCOUNT_ID = 'maritime-account';
export const ACCOUNT_PURPOSE = 'cloud-api';
const origin = 'https://api.maritime.sh';
const diagnostic = (code: string, message: string) => ({ code, severity: 'error' as const, message });
const validToken = (token: unknown): token is string => typeof token === 'string' && token.length > 0 && !/\s/u.test(token);
const operationSignal = (context: { signal: AbortSignal }, signal?: AbortSignal) => signal ? AbortSignal.any([context.signal, signal]) : context.signal;
type ProbeContext = Pick<ConnectedAccountAuthenticationContext, 'signal' | 'services'>;

/** Read-only credential probe; scopes are not inferred from a successful read. */
async function probe(token: string, context: ProbeContext, signal: AbortSignal): Promise<Extract<ConnectedAccountAuthCompletionResult, { status: 'connected' | 'rejected' | 'unavailable' }>> {
  signal.throwIfAborted();
  const url = origin + '/api/v1/account/limits';
  try {
    const response = await context.services.http.request({ url, method: 'GET', headers: { authorization: `Bearer ${token}` }, redirect: 'error' }, { signal });
    signal.throwIfAborted();
    if (response.finalUrl !== url || response.status >= 300 && response.status < 400) throw new Error('maritime_unavailable');
    if (response.status === 401 || response.status === 403) return { status: 'rejected', diagnostic: diagnostic('maritime_invalid_token', 'The Maritime API key is invalid or cannot access this account. Reconnect with an API key with manage scope from Maritime Settings.') };
    const value: unknown = JSON.parse(new TextDecoder().decode(response.body));
    if (response.status !== 200 || typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('maritime_unavailable');
    return { status: 'connected', displayName: 'Maritime', scopes: [] };
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('maritime_unavailable', 'Maritime could not verify the API key. Try again.') };
  }
}

async function health(context: ConnectedAccountReadContext, options?: { signal?: AbortSignal }): Promise<ConnectedAccountHealthResult> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) return { status: 'reconnectRequired', diagnostic: diagnostic('maritime_invalid_token', 'Reconnect Maritime with an API key.') };
    const result = await probe(token, context, signal);
    return result.status === 'rejected' ? { status: 'reconnectRequired', diagnostic: result.diagnostic } : result;
  } catch {
    signal.throwIfAborted();
    return { status: 'unavailable', diagnostic: diagnostic('maritime_unavailable', 'The Maritime connection could not be checked.') };
  }
}

async function materialize(request: ConnectedAccountMaterializationRequest, context: ConnectedAccountPortableReadContext,
  options?: { signal?: AbortSignal }): Promise<ConnectedAccountMaterialization> {
  const signal = operationSignal(context, options?.signal);
  signal.throwIfAborted();
  if (request.kind !== 'httpHeaders' || request.origin !== origin || request.headerNames.some(name => name.toLowerCase() !== 'authorization')) throw new PluginError({ code: 'credential_unavailable' });
  if (!request.headerNames.length) return { kind: 'httpHeaders', headers: {} };
  try {
    const token = await context.credentials.get('token', { signal });
    signal.throwIfAborted();
    if (!validToken(token)) throw new PluginError({ code: 'credential_unavailable' });
    return { kind: 'httpHeaders', headers: { authorization: `Bearer ${token}` } };
  } catch { signal.throwIfAborted(); throw new PluginError({ code: 'credential_unavailable' }); }
}

export const connectedAccountRuntime: ConnectedAccountRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context, options) {
    const signal = operationSignal(context, options?.signal);
    signal.throwIfAborted();
    const supplied = input.fields.token;
    const token = supplied?.trim();
    if (typeof supplied !== 'string' || /[\r\n]/u.test(supplied) || !validToken(token)) return { status: 'rejected', diagnostic: diagnostic('maritime_invalid_token', 'Enter a Maritime API key.') };
    const result = await probe(token, context, signal);
    if (result.status !== 'connected') return result;
    signal.throwIfAborted();
    try { await context.attemptCredentials.set('token', token, { signal }); }
    catch { signal.throwIfAborted(); return { status: 'unavailable', diagnostic: diagnostic('maritime_credential_storage_unavailable', 'The verified Maritime key could not be saved. Try again.') }; }
    signal.throwIfAborted();
    return result;
  } } } },
  status: health,
  refresh: health,
  async revoke(context, options) {
    operationSignal(context, options?.signal).throwIfAborted();
    return { status: 'remoteUnsupported', diagnostic: diagnostic('maritime_manual_revoke_required', 'Revoke the API key in the Maritime dashboard.') };
  },
  materialize,
};
export const connectedAccountPortableRuntime: ConnectedAccountPortableRuntime = { authentication: connectedAccountRuntime.authentication, materialize: connectedAccountRuntime.materialize };
export function activate(api: PluginAccountApi) { api.connectedAccounts.register(ACCOUNT_ID, connectedAccountPortableRuntime); }
