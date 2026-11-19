import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpRequest, HttpService } from '@happier-dev/plugin-sdk/http';
import { connectedAccountRuntime, nativeFetch } from './account.js';
import { createHetznerProvider } from './machine/provider.js';

// Only the host credential store and HTTP boundary are substituted.
function context(status: number): ConnectedAccountReadContext {
  return { signal: new AbortController().signal, configuration: { values: { organizationSlug: 'team' } },
    credentials: { get: async () => 'private-token' }, services: { http: {
      request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode('{}') }),
    } },
  } as unknown as ConnectedAccountReadContext;
}
describe('hetzner captured account health', () => {
  it('uses the public HTTP purpose binding for exact-resource control without native credential services', async () => {
    const requests: HttpRequest[] = [];
    let serverReads = 0;
    const request: HttpService['request'] = async input => {
      requests.push(input);
      const body = new URL(input.url).pathname === '/v1/servers/41'
        ? { server: { id: 41, status: ++serverReads === 1 ? 'off' : 'running', labels: {}, public_net: { ipv4: null, ipv6: null } } }
        : { action: { id: 9, status: input.method === 'POST' ? 'running' : 'success' } };
      return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    };
    // Only the host HTTP transport is substituted. Account hosts have no native materialize service.
    const host = { signal: new AbortController().signal, services: { http: { request } } };
    const provider = createHetznerProvider({ token: 'host-bound', fetch: nativeFetch(host), signal: host.signal });
    const retained = { serverId: 41, owned: { volumeIds: [7], primaryIpIds: [9] } };
    await expect(provider.inspect(retained)).resolves.toMatchObject({ kind: 'present', power: 'stopped',
      billing: { location: 'cloud', stoppedBilling: 'billed' } });
    await expect(provider.power(retained, 'start', async () => {})).resolves.toEqual({ kind: 'confirmed' });
    expect(requests.map(input => ({ path: new URL(input.url).pathname, method: input.method, credentialBinding: input.credentialBinding })))
      .toEqual([
        ['GET', '/v1/servers/41'],
        ['POST', '/v1/servers/41/actions/poweron'],
        ['GET', '/v1/servers/41/actions/9'],
        ['GET', '/v1/servers/41'],
      ].map(([method, path]) => ({
        path, method,
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'cloud-api', origin: 'https://api.hetzner.cloud', method, headerNames: ['authorization'] },
      })));
    expect(requests.every(input => !new Headers(input.headers).has('authorization'))).toBe(true);
  });
  it('materializes direct tokens with one credential read per request and no health or quota HTTP', async () => {
    let credentialReads = 0;
    let httpRequests = 0;
    // Persistent credential storage and the host HTTP transport are the boundaries.
    const base = context(200);
    const host: ConnectedAccountReadContext = {
      ...base,
      credentials: { ...base.credentials, get: async () => { credentialReads += 1; return 'private-token'; } },
      services: { ...base.services, http: { ...base.services.http, request: async () => {
        httpRequests += 1;
        throw new Error('Direct materialization must not probe provider health or quota');
      } } },
    };
    for (let request = 0; request < 3; request += 1) {
      await expect(connectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.hetzner.cloud',
        headerNames: ['Authorization'] }, host)).resolves.toEqual({
        kind: 'httpHeaders', headers: { Authorization: 'Bearer private-token' },
      });
    }
    expect(credentialReads).toBe(3);
    expect(httpRequests).toBe(0);
    expect(connectedAccountRuntime.quota).toBeUndefined();
  });
  it('distinguishes unavailable vendor service from rejected credentials', async () => {
    expect(await connectedAccountRuntime.status(context(503))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(403))).toMatchObject({ status: 'reconnectRequired' });
  });
});
