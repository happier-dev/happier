import { expect, it } from 'vitest';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { nativeFetch } from './credentials.js';

it('captures the Account credential once per role and keeps it off the guest data plane', async () => {
  const calls: HttpRequest[] = [], materializations: unknown[] = [];
  // The host credential store and HTTP transport are genuine system boundaries.
  const context = { signal: new AbortController().signal, services: {
    connectedAccounts: { materialize: async (purpose: unknown, request: unknown) => {
      materializations.push({ purpose, request });
      return { kind: 'httpHeaders', headers: { 'x-api-key': 'private-account-key' } };
    } },
    http: { request: async (request: HttpRequest) => {
      calls.push(request);
      return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode('{}') };
    } },
  } } as unknown as PluginAccountActionContext;
  const request = nativeFetch(context);
  await request('https://api.superserve.ai/sandboxes');
  await request('https://api.superserve.ai/sandboxes/ssb_owned/activate', { method: 'POST' });
  await request('https://sandbox.superserve.ai/exec', { method: 'POST',
    headers: { 'x-access-token': 'private-guest-token', 'x-api-key': 'must-not-leave', 'x-superserve-sandbox-id': 'ssb_owned' } });
  expect(materializations).toEqual([{ purpose: 'cloud-api', request: { kind: 'httpHeaders', origin: 'https://api.superserve.ai', headerNames: ['x-api-key'] } }]);
  expect(calls.slice(0, 2).every(call => call.headers?.['x-api-key'] === 'private-account-key')).toBe(true);
  expect(calls[2]?.headers).toMatchObject({ 'x-access-token': 'private-guest-token', 'x-superserve-sandbox-id': 'ssb_owned' });
  expect(calls[2]?.headers).not.toHaveProperty('x-api-key');
});
