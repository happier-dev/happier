import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime, nativeFetch } from './account.js';
import { createDigitalOceanProvider } from './machine/provider.js';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';

// Only the host credential store and HTTP boundary are substituted.
function context(status: number): ConnectedAccountReadContext {
  return { signal: new AbortController().signal, configuration: { target: { modeId: 'token' }, values: { organizationSlug: 'team' } },
    credentials: { get: async () => 'private-token' }, services: { http: {
      request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode('{}') }),
    } },
  } as unknown as ConnectedAccountReadContext;
}
describe('digitalocean captured account health', () => {
  it('operates through an HTTP-only host with the selected credential kept inside its purpose boundary', async () => {
    const requests: HttpRequest[] = [];
    // This boundary fixture intentionally supplies only the portable HTTP service.
    const portable = { signal: new AbortController().signal, services: { http: {
      request: async (request: HttpRequest) => {
        requests.push(request);
        return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify({
          droplet: { id: 42, name: 'guest', status: 'active', networks: { v4: [{ type: 'public', ip_address: '203.0.113.42' }] } },
        })) };
      },
    } } } satisfies Parameters<typeof nativeFetch>[0];
    const provider = createDigitalOceanProvider({ token: 'host-bound', fetch: nativeFetch(portable) });
    expect(await provider.inspect({ dropletId: 42, ownedVolumeIds: [] })).toMatchObject({ kind: 'present', ready: true });
    expect(requests).toHaveLength(1);
    expect(new Headers(requests[0]!.headers).get('authorization')).toBeNull();
    expect(requests[0]).toMatchObject({ redirect: 'error', credentialBinding: {
      kind: 'connectedAccountPurpose', purpose: 'cloud-api', origin: 'https://api.digitalocean.com', method: 'GET', headerNames: ['authorization'],
    } });
  });
  it('distinguishes unavailable vendor service from rejected credentials', async () => {
    expect(await connectedAccountRuntime.status(context(503))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(403))).toMatchObject({ status: 'reconnectRequired' });
  });
});
