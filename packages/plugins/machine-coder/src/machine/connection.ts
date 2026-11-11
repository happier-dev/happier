import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRuntime, ConnectedAccountPortableRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { ACCOUNT_PURPOSE, ACCOUNT_SERVICE } from './schemas.js';

type HttpService = PluginInvocationContext['services']['http'];
const environmentKeys = ['CODER_URL', 'CODER_SESSION_TOKEN'] as const;
export function coderCredentialUnavailable() {
  return new PluginError({ code: 'credential_unavailable', remediation: { kind: 'selectAccount', service: ACCOUNT_SERVICE } });
}
function connection(values: Readonly<Record<string, unknown>>, token: string | null | undefined) {
  if (typeof values.endpoint !== 'string' || !token) throw coderCredentialUnavailable();
  let endpoint: URL;
  try { endpoint = new URL(values.endpoint); } catch { throw coderCredentialUnavailable(); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') throw coderCredentialUnavailable();
  return { endpoint: endpoint.origin, token };
}
function requestWithConnection(selected: ReturnType<typeof connection>, http: HttpService, signal: AbortSignal) {
  return async (path: string, init: RequestInit = {}) => {
    signal.throwIfAborted();
    const url = selected.endpoint + path;
    const headers = Object.fromEntries(new Headers(init.headers));
    headers['Coder-Session-Token'] = selected.token;
    const method = init.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new PluginError({ code: 'invalid_request' });
    const response = await http.request({ url, method, headers, redirect: 'error',
      ...(init.body === undefined ? {} : { body: new TextEncoder().encode(String(init.body)) }) }, { signal });
    signal.throwIfAborted();
    if (response.finalUrl !== url) throw coderCredentialUnavailable();
    return new Response(Uint8Array.from(response.body), { status: response.status, headers: response.headers });
  };
}
async function probe(selected: ReturnType<typeof connection>, context: { services: { http: HttpService }; signal: AbortSignal }) {
  const response = await requestWithConnection(selected, context.services.http, context.signal)('/api/v2/users/me');
  if (!response.ok) throw coderCredentialUnavailable();
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string'
    || !('username' in body) || typeof body.username !== 'string') throw coderCredentialUnavailable();
  return body.username;
}
export const CODER_PORTABLE_ACCOUNT_RUNTIME: ConnectedAccountPortableRuntime = {
  authentication: { modes: { token: { kind: 'manual', async complete(input, context) {
    try {
      const selected = connection(context.configuration.values, input.fields.token);
      // Private deployments may reject browser origins; authenticate on the controller at use.
      await context.attemptCredentials.set('token', selected.token);
      return { status: 'connected', displayName: selected.endpoint, scopes: [],
        ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}) };
    } catch {
      return { status: 'rejected', diagnostic: { code: 'credential_unavailable', severity: 'error',
        message: 'Check the Coder deployment URL and your user token.' } };
    }
  } } } },
};
export const CODER_CONNECTED_ACCOUNT_RUNTIME: ConnectedAccountRuntime = {
  authentication: CODER_PORTABLE_ACCOUNT_RUNTIME.authentication,
  async refresh(context) { return this.status(context); },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async status(context) {
    try { return { status: 'connected', displayName: await probe(connection(context.configuration.values, await context.credentials.get('token')), context), scopes: [] }; }
    catch { return { status: 'unavailable' }; }
  },
  async materialize(request, context) {
    if (request.kind !== 'environment' || request.keys.some(key => !environmentKeys.some(known => key === known))) throw coderCredentialUnavailable();
    const selected = connection(context.configuration.values, await context.credentials.get('token'));
    const values: Readonly<Record<string, string>> = { CODER_URL: selected.endpoint, CODER_SESSION_TOKEN: selected.token };
    return { kind: 'environment', env: Object.fromEntries(request.keys.map(key => [key, values[key]])) };
  },
};

/** Capture the selected account once. All finite native steps share its private material. */
export async function prepareCoderConnection(accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'>, http: HttpService, signal: AbortSignal) {
  signal.throwIfAborted();
  const binding = await accounts.getBinding(ACCOUNT_PURPOSE, { signal });
  if (!binding || binding.account.service.pluginId !== ACCOUNT_SERVICE.pluginId || binding.account.service.localId !== ACCOUNT_SERVICE.localId) throw coderCredentialUnavailable();
  const material = await accounts.materialize(ACCOUNT_PURPOSE, { kind: 'environment', keys: environmentKeys }, { signal, expectedAccount: binding.account });
  signal.throwIfAborted();
  if (material.kind !== 'environment') throw coderCredentialUnavailable();
  const selected = connection({ endpoint: material.env.CODER_URL }, material.env.CODER_SESSION_TOKEN);
  return { ...selected, request: requestWithConnection(selected, http, signal) };
}
