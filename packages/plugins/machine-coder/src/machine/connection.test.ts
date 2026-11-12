import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import { prepareCoderConnection } from './connection.js';
import { ACCOUNT_PURPOSE, ACCOUNT_SERVICE } from './schemas.js';
import { createCoderClient } from './nativeClient.js';

const token = 'coder-private-test-token';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture(status = 200, abortAfterReply = false) {
  const abort = new AbortController();
  const credentialsSeen: Array<string | undefined> = [];
  const server = createServer((req, res) => { credentialsSeen.push(req.headers['coder-session-token'] as string | undefined);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { id: 'user-a', username: 'alice' } : { message: token })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing address');
  const endpoint = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  let selections = 0, materializations = 0;
  const accounts: Pick<ConnectedAccountsService, 'getBinding' | 'materialize'> = {
    async getBinding(purpose) { expect(purpose).toBe(ACCOUNT_PURPOSE); selections++;
      return { account: { service: ACCOUNT_SERVICE, accountId: 'selected' }, source: 'account' }; },
    async materialize(purpose, request, options) { expect(purpose).toBe(ACCOUNT_PURPOSE);
      expect(options?.expectedAccount).toEqual({ service: ACCOUNT_SERVICE, accountId: 'selected' });
      expect(request.kind).toBe('environment'); materializations++;
      return { kind: 'environment', env: { CODER_URL: endpoint, CODER_SESSION_TOKEN: token } }; },
  };
  const http: PluginInvocationContext['services']['http'] = { request: async (request, options) => {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body,
      signal: options?.signal, redirect: request.redirect });
    const body = new Uint8Array(await response.arrayBuffer());
    if (abortAfterReply) abort.abort(new Error('role-ended'));
    return { status: response.status, finalUrl: response.url, headers: Object.fromEntries(response.headers), body };
  } };
  const prepared = await prepareCoderConnection(accounts, http, abort.signal);
  return { prepared, credentialsSeen, counts: () => ({ selections, materializations }) };
}
describe('Coder connected account invocation custody', () => {
  it('preserves a completed connection HTTP reply and cancels the next dispatch', async () => {
    const h = await fixture(200, true);
    const response = await h.prepared.request('/api/v2/users/me', { method: 'POST' });
    expect(await response.json()).toEqual({ id: 'user-a', username: 'alice' });
    await expect(h.prepared.request('/api/v2/users/me', { method: 'POST' })).rejects.toThrow('role-ended');
    expect(h.credentialsSeen).toHaveLength(1);
  });

  it('materializes once per finite invocation and sends the secret solely in the deployment header', async () => {
    const h = await fixture(); const client = createCoderClient({ request: h.prepared.request,
      signal: new AbortController().signal, observedAt: 1, waitForObservation: async () => {} });
    expect(await client.check()).toEqual({ available: true });
    expect(await client.check()).toEqual({ available: true });
    expect(h.counts()).toEqual({ selections: 1, materializations: 1 });
    expect(h.credentialsSeen.every(value => value === token)).toBe(true);
    expect(JSON.stringify(await client.check())).not.toContain(token);
  });
  it('projects a rejected token as typed reconnect without reflected server text', async () => {
    const h = await fixture(401); const client = createCoderClient({ request: h.prepared.request,
      signal: new AbortController().signal, observedAt: 1, waitForObservation: async () => {} });
    const error: unknown = await client.check().catch(error => error);
    expect(error).toBeInstanceOf(PluginError);
    expect(error).toMatchObject({ code: 'credential_unavailable', remediation: { kind: 'selectAccount', service: ACCOUNT_SERVICE } });
    expect(JSON.stringify(error)).not.toContain(token);
  });
  it('preserves a typed broker failure instead of flattening it into provider unavailable', async () => {
    const error = new PluginError({ code: 'broker_unavailable', remediation: { kind: 'retry' }, details: { phase: 'materialize' } });
    const accounts = { getBinding: async () => { throw error; }, materialize: async () => { throw new Error('not reached'); } };
    await expect(prepareCoderConnection(accounts, {} as PluginInvocationContext['services']['http'], new AbortController().signal)).rejects.toBe(error);
  });
});
