import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { devinConnectedAccountRuntime as runtime } from './runtime.js';

type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
function fixture(values: Readonly<Record<string, string>>, outcome: number | Error = 200) {
  const requests: Array<Parameters<ReadContext['services']['http']['request']>[0]> = [];
  const controller = new AbortController();
  let abortOnRequest = false;
  // Credential custody and HTTP are the genuine host boundaries; the plugin leaf stays real.
  const context = { credentials: { async get(key: string) { return values[key] ?? null; } },
    configuration: { values: {} }, invokedAtMs: 1000, signal: controller.signal,
    services: { http: createPluginHttpFixture({ async request(input) {
      requests.push(input);
      if (abortOnRequest) controller.abort(outcome);
      if (outcome instanceof Error) throw outcome;
      return { status: outcome, headers: {}, body: new TextEncoder().encode(JSON.stringify({ data: [], user_id: 'synthetic-user' })) };
    } }) },
  } as ReadContext;
  return { context, requests, abortDuringRequest() { abortOnRequest = true; } };
}

describe('Devin no-usage connection check', () => {
  it('reads the session profile using its Bearer contract, without a token exchange', async () => {
    const f = fixture({ credentialMode: 'session', sessionToken: 'synthetic-token', apiServerUrl: 'https://server.codeium.com' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toEqual([expect.objectContaining({ url: 'https://api.devin.ai/v3/self', method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token' }) })]);
  });
  it('does not send an enterprise seat token to the public session endpoint', async () => {
    const f = fixture({ credentialMode: 'enterprise', seatToken: 'synthetic-token', apiServerUrl: 'https://enterprise.example' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    expect(f.requests).toEqual([]);
  });
  it('does not send an imported session token to an uncharacterized profile server', async () => {
    const f = fixture({ credentialMode: 'session', sessionToken: 'synthetic-token', nativeMetadata: JSON.stringify({ devin_api_url: 'https://private.example' }) });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    expect(f.requests).toEqual([]);
  });

  it.each([
    [401, 'needsReauth'], [403, 'unsupported'], [429, 'networkUnavailable'], [503, 'networkUnavailable'],
    [new Error('synthetic-token must never escape'), 'networkUnavailable'],
  ] as const)('reports a secret-free %s failure as %s', async (outcome, status) => {
    const f = fixture({ credentialMode: 'session', sessionToken: 'synthetic-token' }, outcome);
    const result = await runtime.testConnection!(f.context);
    expect(result).toMatchObject({ status, code: expect.any(String), reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(f.requests).toHaveLength(1);
  });
  it('preserves cancellation instead of reporting a connection failure', async () => {
    const failure = new Error('cancelled');
    const f = fixture({ credentialMode: 'session', sessionToken: 'synthetic-token' }, failure);
    f.abortDuringRequest();
    await expect(runtime.testConnection!(f.context)).rejects.toBe(failure);
  });
  it('reports missing credentials without making a remote request', async () => {
    const f = fixture({});
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
    expect(f.requests).toEqual([]);
  });
});
