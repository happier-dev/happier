import { expect, it } from 'vitest';
import { nativeFetch } from './credentials.js';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';

it('captures the selected API key once per role and never sends it to envd', async () => {
  const requests: HttpRequest[] = [];
  let uses = 0;
  const context = { signal: new AbortController().signal, services: {
    connectedAccounts: { async materialize() { uses++; return { kind: 'httpHeaders' as const, headers: { 'x-api-key': 'private-api-key' } }; } },
    http: { async request(input: HttpRequest) { requests.push(input); return { status: 200, finalUrl: input.url, headers: {}, body: new TextEncoder().encode('{}') }; } },
  } };
  const fetch = nativeFetch(context);
  await fetch('https://api.e2b.app/v2/sandboxes');
  await fetch('https://api.e2b.app/sandboxes/one');
  await fetch('https://49983-one.e2b.app/process.Process/Start', { method: 'POST', body: new Uint8Array([0]), headers: { 'x-access-token': 'private-guest-token', authorization: 'Basic cm9vdDo=' } });
  expect(uses).toBe(1);
  expect(requests.map(r => r.headers?.['x-api-key'])).toEqual(['private-api-key', 'private-api-key', undefined]);
  expect(requests[2]?.headers).toMatchObject({ 'x-access-token': 'private-guest-token' });
  await nativeFetch(context)('https://api.e2b.app/v2/sandboxes');
  expect(uses).toBe(2);
});
