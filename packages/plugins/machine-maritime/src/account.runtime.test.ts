import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountCredentialStore, ConnectedAccountMutationContext, ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest, HttpResponse } from '@happier-dev/plugin-sdk/http';
import * as entry from './index.js';

const service = { pluginId: 'happier.machine.maritime', localId: 'maritime-account' };
const secret = 'constructed-private-maritime-token';
const accountId = 'selected-account';
// Constructed Maritime OpenAPI 0.1.0 list responses, never real tenant captures.

async function host(options: {
  values?: Record<string, string>; response?: unknown; status?: number; finalUrl?: string;
  failure?: Error; storageFailure?: Error; afterRequest?: (controller: AbortController) => void;
} = {}) {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
  const runtime = kit.registration('connectedAccountDescriptors', service.localId);
  if (!runtime) await kit.dispose();
  expect(runtime, 'activated vendor Connected Account runtime').toBeDefined();
  if (!runtime) throw new Error('Missing deployment Connected Account runtime');
  const controller = new AbortController();
  const requests: HttpRequest[] = [];
  const requestSignals: (AbortSignal | undefined)[] = [];
  const values = options.values ?? {};
  const staged = new Map<string, string>();
  const retained = new Map<string, string>([['token', secret]]);
  const store = (map: Map<string, string>): ConnectedAccountCredentialStore => ({
    async get(key) { return map.get(key) ?? null; },
    async set(key, value) { if (options.storageFailure) throw options.storageFailure; map.set(key, value); },
    async delete(key) { map.delete(key); },
  });
  let response: unknown = options.response ?? { plan: 'growth', minMemMb: 512, maxMemMb: 8192, maxDiskGb: 100 };
  let status = options.status ?? 200;
  const http = createPluginHttpFixture({
    async request(request: HttpRequest, cancellation?: { signal?: AbortSignal }): Promise<HttpResponse> {
      requests.push(request); requestSignals.push(cancellation?.signal);
      if (options.failure) throw options.failure;
      options.afterRequest?.(controller);
      return { status, finalUrl: options.finalUrl ?? request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(response)) };
    },
  });
  // Only vendor HTTP and credential persistence are substituted. Unexpected
  // services fail closed, as in the SDK's public Connected Account fixture.
  const services = new Proxy({} as ConnectedAccountReadContext['services'], {
    get(_target, key) { if (key === 'http') return http; throw new Error('Unadmitted service ' + String(key)); },
  });
  const common = { plugin: { id: service.pluginId, version: entry.manifest.version },
    contribution: { id: service.localId, qualifiedId: service.pluginId + '/' + service.localId },
    surface: 'background' as const, invokedAtMs: 1000, services, signal: controller.signal };
  const account = { service, accountId };
  const configuration = { target: { kind: 'account' as const, account, modeId: 'token' },
    revision: 'configuration-1', values, async getSecret() { return null; } };
  const read = { ...common, configuration, account, credentials: store(retained) } satisfies ConnectedAccountReadContext;
  const authentication = { ...common, service, attempt: { kind: 'connect' as const, attemptId: 'attempt-1' },
    configuration: { ...configuration, target: { kind: 'attempt' as const, attemptId: 'attempt-1', service, modeId: 'token' } },
    attemptCredentials: store(staged) } satisfies ConnectedAccountAuthenticationContext;
  const mutation = { ...read, operation: { operationId: 'operation-1', configurationRevision: configuration.revision },
    stagedCredentials: store(staged) } satisfies ConnectedAccountMutationContext;
  const mode = runtime.authentication.modes.token;
  if (mode?.kind !== 'manual') { await kit.dispose(); throw new Error('Missing manual mode'); }
  return { kit, runtime, mode, authentication, read, mutation, staged, retained, controller, requests, requestSignals,
    respond(next: unknown, nextStatus = 200) { response = next; status = nextStatus; } };
}

describe('Maritime selected Account API key', () => {
  it('does not stage a key when the limits endpoint returns an unrelated object', async () => {
    const h = await host({ response: {} });
    try {
      expect(await h.mode.complete({ fields: { token: secret } }, h.authentication)).toMatchObject({
        status: 'unavailable', diagnostic: { code: 'maritime_invalid_response' },
      });
      expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });
  it('token auth validates the account-scoped key by a read before staging it, then materializes only for the API origin', async () => {
    const h = await host();
    try {
      expect(await h.mode.complete({ fields: { token: secret } }, h.authentication)).toMatchObject({ status: 'connected', scopes: [] });
      expect(h.staged.get('token')).toBe(secret);
      expect(h.requests[0]).toMatchObject({ method: 'GET', url: 'https://api.maritime.sh/api/v1/account/limits', headers: { authorization: `Bearer ${secret}` }, redirect: 'error' });
      expect(await h.runtime.materialize({ kind: 'httpHeaders', origin: 'https://api.maritime.sh', headerNames: ['authorization'] }, h.read)).toEqual({ kind: 'httpHeaders', headers: { authorization: `Bearer ${secret}` } });
      await expect(h.runtime.materialize({ kind: 'httpHeaders', origin: 'https://49983-sandbox.maritime.app', headerNames: ['authorization'] }, h.read)).rejects.toThrow('credential_unavailable');
    } finally { await h.kit.dispose(); }
  });
  it.each([401, 403, 429, 503])('never stages denied or unavailable credentials (%s)', async status => {
    const h = await host({ status, response: { message: secret, code: secret } });
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result.status).toBe(status === 401 || status === 403 ? 'rejected' : 'unavailable');
      expect(h.staged.size).toBe(0); expect(JSON.stringify(result)).not.toContain(secret);
    } finally { await h.kit.dispose(); }
  });
  it('propagates cancellation before saving a verified token', async () => {
    const h = await host({ afterRequest: controller => controller.abort(new Error('cancelled')) });
    try {
      await expect(h.mode.complete({ fields: { token: secret } }, h.authentication)).rejects.toThrow('cancelled');
      expect(h.staged.size).toBe(0);
    } finally { await h.kit.dispose(); }
  });
  it('reports storage failure without connecting, and requires reconnect after a retained key is denied', async () => {
    const h = await host({ storageFailure: new Error(secret) });
    try {
      const result = await h.mode.complete({ fields: { token: secret } }, h.authentication);
      expect(result.status).toBe('unavailable');
      expect(h.staged.size).toBe(0);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(await h.runtime.status(h.read)).toMatchObject({ status: 'connected' });
      h.respond({ message: secret }, 401);
      expect(await h.runtime.refresh(h.mutation)).toMatchObject({ status: 'reconnectRequired' });
      expect(h.retained.get('token')).toBe(secret);
    } finally { await h.kit.dispose(); }
  });
});
