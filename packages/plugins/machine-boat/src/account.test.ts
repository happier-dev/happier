import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime, nativeFetch } from './account.js';

function context(status: number, code: string): ConnectedAccountReadContext {
  const value = status === 200
    ? { ok: true, type: 'limits.info', sandboxPlanDollars: 20, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
    : { ok: false, type: 'sandbox.error', status, code, message: code, error: { code, message: code, status }, requestId: 'req_test' };
  return { signal: new AbortController().signal, configuration: { values: {} }, credentials: { get: async () => 'private-token' },
    services: { http: { request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) }) } },
  } as unknown as ConnectedAccountReadContext;
}

describe('Boat captured account health', () => {
  it('uses the captured HTTP purpose without native credential services or reading its bearer', async () => {
    const request = vi.fn(async (input: HttpRequest) => ({ status: 200, finalUrl: input.url, headers: {}, body: new Uint8Array() }));
    const invocation = { signal: new AbortController().signal, services: { http: { request } } };
    const transport = nativeFetch(invocation);
    await Promise.all([transport('https://boat.dev/api/v1/limits'), transport('https://boat.dev/api/v1/sandboxes'),
      transport('https://boat.dev/api/v1/sandboxes/bx_23456789', { method: 'PATCH', body: JSON.stringify({ ttlSeconds: 7200 }) })]);
    expect(request.mock.calls).toHaveLength(3);
    for (const [input] of request.mock.calls) {
      expect(input.credentialBinding).toEqual({ kind: 'connectedAccountPurpose', purpose: 'cloud-api',
        origin: 'https://boat.dev', method: input.method ?? 'GET', headerNames: ['authorization'] });
      expect(new Headers(input.headers).has('authorization')).toBe(false);
    }
  });
  it('cancels an admitted HTTP fragment when its role ends even with a separate request signal', async () => {
    const role = new AbortController();
    const fragment = new AbortController();
    const request = vi.fn(async (input: HttpRequest) => ({ status: 200, finalUrl: input.url, headers: {}, body: new Uint8Array() }));
    const transport = nativeFetch({ signal: role.signal, services: { http: { request } } });
    role.abort(new Error('role-ended'));
    await expect(transport('https://boat.dev/api/v1/limits', { signal: fragment.signal })).rejects.toThrow('role-ended');
    expect(request).not.toHaveBeenCalled();
  });
  it('distinguishes rejected credentials from unavailable service', async () => {
    expect(await connectedAccountRuntime.status(context(401, 'unauthorized'))).toMatchObject({ status: 'reconnectRequired' });
    expect(await connectedAccountRuntime.status(context(503, 'http_500'))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(200, 'ok'))).toMatchObject({ status: 'connected', displayName: 'Boat' });
  });
});
