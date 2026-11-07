import { expect, it } from 'vitest';
import { nativeFetch } from './credentials.js';
import { connectedAccountPortableRuntime } from '../account.js';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import type { ConnectedAccountPortableReadContext } from '@happier-dev/plugin-sdk/connected-accounts';

it('uses the selected account at both documented origins without exposing its key', async () => {
  const requests: HttpRequest[] = []; const uses: string[] = [];
  const context = { signal: new AbortController().signal, services: {
    connectedAccounts: { async materialize(_purpose: string, request: { origin: string }) {
      uses.push(request.origin);
      return { kind: 'httpHeaders' as const, headers: request.origin === 'https://api.agent37.com'
        ? { authorization: 'Bearer fixture-secret' } : { 'x-agent37-key': 'fixture-secret' } };
    } },
    http: { async request(input: HttpRequest) { requests.push(input); return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{}') }; } },
  } };
  const request = nativeFetch(context);
  await request('https://api.agent37.com/v1/instances');
  await request('https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec', { method: 'POST' });
  await request('https://sandbox.agent37.app/v1/instances/ab12cd34ef/exec', { method: 'POST' });
  expect(uses).toEqual(['https://api.agent37.com', 'https://sandbox.agent37.app']);
  expect(requests[0]?.headers).toMatchObject({ authorization: 'Bearer fixture-secret' });
  expect(requests[1]?.headers).toMatchObject({ 'x-agent37-key': 'fixture-secret' });
  expect(requests[1]?.headers).not.toHaveProperty('authorization');
  await expect(request('https://other.agent37.app/v1/instances')).rejects.toThrow();
  expect(requests).toHaveLength(3);
});

it('formats each origin materialization through the real connected account runtime', async () => {
  // Credential storage is a genuine boundary; there is no host/selection stub here.
  const context = { signal: new AbortController().signal, credentials: { get: async () => 'fixture-secret' } } as unknown as ConnectedAccountPortableReadContext;
  expect(await connectedAccountPortableRuntime.materialize!({ kind: 'httpHeaders', origin: 'https://api.agent37.com', headerNames: ['authorization'] }, context))
    .toEqual({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-secret' } });
  expect(await connectedAccountPortableRuntime.materialize!({ kind: 'httpHeaders', origin: 'https://sandbox.agent37.app', headerNames: ['x-agent37-key'] }, context))
    .toEqual({ kind: 'httpHeaders', headers: { 'x-agent37-key': 'fixture-secret' } });
  await expect(connectedAccountPortableRuntime.materialize!({ kind: 'httpHeaders', origin: 'https://other.agent37.app', headerNames: ['x-agent37-key'] }, context)).rejects.toThrow();
});
