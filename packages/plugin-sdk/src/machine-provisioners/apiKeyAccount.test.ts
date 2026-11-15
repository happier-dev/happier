import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '../connected-accounts/index.js';
import { PluginError } from '../errors.js';
import { createPluginHttpFixture } from '../testing/http.js';
import { createMachineProvisionerApiKeyAccount } from './apiKeyAccount.js';

const secret = 'constructed-private-token';
const service = { pluginId: 'example.machine', localId: 'account' };
const account = { service, accountId: 'account-one' };
const runtime = createMachineProvisionerApiKeyAccount({
  name: 'Example', keyDescription: 'an Example key', codePrefix: 'example', purpose: 'cloud-api',
  headers: [{ origin: 'https://api.example.test', headerName: 'authorization', scheme: 'bearer' }],
  probe: { request: { url: 'https://api.example.test/account', method: 'GET' },
    read: () => ({ status: 'connected', scopes: [] }) },
}).runtime;

function context(status: number, failure?: Error): ConnectedAccountReadContext {
  const http = createPluginHttpFixture({ async request(request) {
    if (failure) throw failure;
    return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode('{}') };
  } });
  // Only HTTP and credential persistence are boundary substitutes.
  const services = new Proxy({} as ConnectedAccountReadContext['services'], {
    get(_target, key) { if (key === 'http') return http; throw new Error('Unexpected service'); },
  });
  return { plugin: { id: service.pluginId, version: '0.0.0' },
    contribution: { id: service.localId, qualifiedId: service.pluginId + '/' + service.localId },
    surface: 'background', invokedAtMs: 1000, signal: new AbortController().signal, services, account,
    configuration: { target: { kind: 'account', account, modeId: 'token' }, revision: 'one', values: {},
      async getSecret() { return null; } },
    credentials: { async get() { return secret; } } };
}

describe('machine API key probe failure evidence', () => {
  it('retains the thrown PluginError cause without disclosing its message', async () => {
    const result = await runtime.status(context(200, new PluginError({ code: 'plugin_fetch_adapter_unavailable', message: secret })));
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { details: { failureCause: {
      phase: 'machine.account.probe', errorCode: 'plugin_fetch_adapter_unavailable', httpStatus: null,
    } } } });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([429, 503])('retains HTTP %s and marks only explicit rate limits', async status => {
    const result = await runtime.status(context(status));
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { details: {
      httpStatus: status, failureCause: { phase: 'machine.account.probe', httpStatus: status },
    } } });
    if (status === 429) expect(result).toHaveProperty('failureClass', 'rateLimit');
    else expect(result).not.toHaveProperty('failureClass');
  });
});
