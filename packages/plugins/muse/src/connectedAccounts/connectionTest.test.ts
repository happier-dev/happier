import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { museConnectedAccountRuntime as runtime } from './museAccountRuntime.js';

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

describe('Muse no-usage connection check', () => {
  it.each(['manual', 'native'] as const)('checks the %s inference key with the model read, without minting a key', async credentialMode => {
    const f = fixture({ inferenceKey: 'synthetic-token', accountToken: 'synthetic-account', credentialMode,
      ...(credentialMode === 'native' ? { nativeApiBaseUrl: 'https://api.meta.ai/v1/' } : {}) });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toEqual([expect.objectContaining({ url: 'https://api.meta.ai/v1/models', method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token', 'x-api-version': '1.0.0' }) })]);
  });
  it('does not send a native key to an uncharacterized server', async () => {
    const f = fixture({ inferenceKey: 'synthetic-token', credentialMode: 'native', nativeApiBaseUrl: 'https://other.example/v1' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    expect(f.requests).toEqual([]);
  });

  it.each([
    [401, 'needsReauth'], [403, 'unsupported'], [429, 'networkUnavailable'], [503, 'networkUnavailable'],
    [new Error('synthetic-token must never escape'), 'networkUnavailable'],
  ] as const)('reports a secret-free %s failure as %s', async (outcome, status) => {
    const f = fixture({ inferenceKey: 'synthetic-token', credentialMode: 'manual' }, outcome);
    const result = await runtime.testConnection!(f.context);
    expect(result).toMatchObject({ status, code: expect.any(String), reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(f.requests).toHaveLength(1);
  });
  it('preserves cancellation instead of reporting a connection failure', async () => {
    const failure = new Error('cancelled');
    const f = fixture({ inferenceKey: 'synthetic-token', credentialMode: 'manual' }, failure);
    f.abortDuringRequest();
    await expect(runtime.testConnection!(f.context)).rejects.toBe(failure);
  });
  it('reports missing credentials without making a remote request', async () => {
    const f = fixture({});
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
    expect(f.requests).toEqual([]);
  });
});
