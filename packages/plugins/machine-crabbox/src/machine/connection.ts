import type { ConnectedAccountRuntime, ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { CrabboxCoordinatorClient } from './nativeClient.js';
import type { CrabboxHttp } from './nativeClient.js';
import { CRABBOX_CONNECTION_PURPOSE, CRABBOX_CONNECTION_SERVICE } from './constants.js';
type HttpService = PluginInvocationContext['services']['http'];

export { CRABBOX_CONNECTION_PURPOSE, CRABBOX_CONNECTION_SERVICE } from './constants.js';
const environmentKeys = ['CRABBOX_COORDINATOR_URL', 'CRABBOX_COORDINATOR_TOKEN', 'CRABBOX_ORG'] as const;

function unavailable() {
  return Object.assign(new Error('selected Crabbox coordinator connection unavailable'), { code: 'credential_unavailable' });
}

function connection(values: Readonly<Record<string, unknown>>, token: string | null | undefined) {
  if (typeof values.endpoint !== 'string' || typeof values.namespace !== 'string' || !token) throw unavailable();
  const selected = { endpoint: values.endpoint, namespace: values.namespace, token };
  // Constructor validation performs no network request or acquisition.
  new CrabboxCoordinatorClient(selected);
  return selected;
}

export const CRABBOX_CONNECTED_ACCOUNT_RUNTIME: ConnectedAccountRuntime = {
  authentication: { modes: { token: {
    kind: 'manual',
    async complete(input, context) {
      try {
        const selected = connection(context.configuration.values, input.fields.token);
        await context.attemptCredentials.set('token', selected.token);
        return { status: 'connected', ...(context.attempt.kind === 'reconnect' ? { accountId: context.attempt.account.accountId } : {}),
          displayName: 'Crabbox coordinator', scopes: [] };
      } catch {
        return { status: 'rejected', diagnostic: { code: 'native_connection_invalid', severity: 'error', message: 'Review the Crabbox coordinator connection.' } };
      }
    },
  } } },
  async refresh(context) { return this.status(context); },
  async revoke() { return { status: 'remoteUnsupported' }; },
  async status(context) {
    try {
      connection(context.configuration.values, await context.credentials.get('token'));
      return { status: 'connected', displayName: 'Crabbox coordinator', scopes: [] };
    } catch { return { status: 'unavailable' }; }
  },
  async materialize(request, context) {
    if (request.kind !== 'environment' || request.keys.some(key => !environmentKeys.includes(key as typeof environmentKeys[number]))) throw unavailable();
    const selected = connection(context.configuration.values, await context.credentials.get('token'));
    const values: Readonly<Record<string, string>> = {
      CRABBOX_COORDINATOR_URL: selected.endpoint, CRABBOX_COORDINATOR_TOKEN: selected.token, CRABBOX_ORG: selected.namespace,
    };
    return { kind: 'environment', env: Object.fromEntries(request.keys.map(key => [key, values[key]])) };
  },
};

/** Each invocation captures one admitted account and connection. Every request
 * re-materializes that exact account so retirement/configuration drift refuses
 * before native IO; no ambient environment or default coordinator is consulted. */
export async function prepareCrabboxConnection(accounts: ConnectedAccountsService, http: HttpService, signal: AbortSignal) {
  const binding = await accounts.getBinding(CRABBOX_CONNECTION_PURPOSE, { signal });
  if (!binding || binding.account.service.pluginId !== CRABBOX_CONNECTION_SERVICE.pluginId
    || binding.account.service.localId !== CRABBOX_CONNECTION_SERVICE.localId) throw unavailable();
  const account = binding.account;
  async function materialize() {
    const value = await accounts.materialize(CRABBOX_CONNECTION_PURPOSE, { kind: 'environment', keys: environmentKeys }, { signal, expectedAccount: account });
    if (value.kind !== 'environment') throw unavailable();
    return connection({ endpoint: value.env.CRABBOX_COORDINATOR_URL, namespace: value.env.CRABBOX_ORG }, value.env.CRABBOX_COORDINATOR_TOKEN);
  }
  const selected = await materialize();
  const nativeHttp: CrabboxHttp = async (url, init) => {
    const current = await materialize();
    if (current.endpoint !== selected.endpoint || current.namespace !== selected.namespace) throw unavailable();
    const method = init.method;
    if (method !== 'GET' && method !== 'PUT' && method !== 'POST') throw unavailable();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers.authorization = `Bearer ${current.token}`;
    const reply = await http.request({ url, method, headers, redirect: 'error',
      ...(init.body === undefined ? {} : { body: new TextEncoder().encode(String(init.body)) }) }, { signal });
    if (reply.finalUrl !== url) throw unavailable();
    return new Response(Uint8Array.from(reply.body), { status: reply.status, headers: reply.headers });
  };
  return { connection: selected, http: nativeHttp };
}
