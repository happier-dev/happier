import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext, ConnectedAccountAuthenticationContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';

// Only the host credential store and HTTP boundary are substituted.
function context(status: number): ConnectedAccountReadContext {
  return { signal: new AbortController().signal, configuration: { values: { organizationSlug: 'team' } },
    credentials: { get: async () => 'private-token' }, services: { http: {
      request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode('{}') }),
    } },
  } as unknown as ConnectedAccountReadContext;
}
describe('fly captured account health', () => {
  it('connects and materializes the documented FlyV1 token without adding Bearer', async () => {
    const token = 'FlyV1 fm2_constructed-not-a-real-key';
    const calls: Readonly<Record<string, string>>[] = [];
    const staged: string[] = [];
    const common = context(200);
    const services = { http: { request: async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      calls.push(request.headers ?? {});
      return { status: 200, finalUrl: request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify({ apps: [], total_apps: 0 })) };
    } } };
    const mode = connectedAccountRuntime.authentication!.modes.token!;
    if (mode.kind !== 'manual') throw new Error('Expected manual authentication');
    const authentication = { ...common, services,
      attemptCredentials: { set: async (_key: string, value: string) => { staged.push(value); } },
    } as unknown as ConnectedAccountAuthenticationContext;
    expect(await mode.complete({ fields: { token } }, authentication)).toMatchObject({ status: 'connected' });
    expect(staged).toEqual([token]);
    expect(new Headers(calls[0]).get('authorization')).toBe(token);
    const materialized = await connectedAccountRuntime.materialize({ kind: 'httpHeaders',
      origin: 'https://api.machines.dev', headerNames: ['authorization'] },
    { ...common, credentials: { ...common.credentials, get: async () => token } });
    expect(materialized.kind === 'httpHeaders' && new Headers(materialized.headers).get('authorization')).toBe(token);
  });
  it('distinguishes unavailable vendor service from rejected credentials', async () => {
    expect(await connectedAccountRuntime.status(context(503))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(403))).toMatchObject({ status: 'reconnectRequired' });
  });
});
