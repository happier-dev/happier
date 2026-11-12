import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createKimiConnectedAccountRuntime, kimiPortableAccountRuntime } from './runtime.js';
const runtime = createKimiConnectedAccountRuntime();

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

describe('Kimi no-usage connection check', () => {
  it.each([
    ['oauth', 'code', 'https://api.kimi.ai/coding/v1'],
    ['token', 'code', 'https://api.kimi.com/coding/v1'],
    ['token', 'platform', 'https://api.moonshot.cn/v1'],
    ['token', 'platform', 'https://api.moonshot.ai/v1'],
  ] as const)('checks %s/%s at the selected %s model endpoint with its device header', async (credentialKind, apiKind, apiBase) => {
    const f = fixture({ accessToken: 'synthetic-token', credentialKind, apiKind, apiBase, deviceId: 'synthetic-device' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toEqual([expect.objectContaining({ url: `${apiBase}/models`, method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token', 'X-Msh-Device-Id': 'synthetic-device' }) })]);
  });
  it('exposes the same read to Account-side API key execution', async () => {
    const f = fixture({ accessToken: 'synthetic-token', credentialKind: 'token', apiKind: 'code', apiBase: 'https://api.kimi.ai/coding/v1' });
    expect(await kimiPortableAccountRuntime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests.map(request => request.url)).toEqual(['https://api.kimi.ai/coding/v1/models']);
  });

  it.each([
    [401, 'needsReauth'], [403, 'unsupported'], [429, 'networkUnavailable'], [503, 'networkUnavailable'],
    [new Error('synthetic-token must never escape'), 'networkUnavailable'],
  ] as const)('reports a secret-free %s failure as %s', async (outcome, status) => {
    const f = fixture({ accessToken: 'synthetic-token', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1' }, outcome);
    const result = await runtime.testConnection!(f.context);
    expect(result).toMatchObject({ status, code: expect.any(String), reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(f.requests).toHaveLength(1);
  });
  it('preserves cancellation instead of reporting a connection failure', async () => {
    const failure = new Error('cancelled');
    const f = fixture({ accessToken: 'synthetic-token', credentialKind: 'oauth', apiBase: 'https://api.kimi.ai/coding/v1' }, failure);
    f.abortDuringRequest();
    await expect(runtime.testConnection!(f.context)).rejects.toBe(failure);
  });
  it('preserves selected endpoint credential custody failures as host errors', async () => {
    const f = fixture({});
    const failure = new Error('credential custody unavailable');
    const context = { ...f.context, credentials: { async get(key: string) {
      if (key === 'apiBase') throw failure;
      return key === 'accessToken' ? 'synthetic-token' : null;
    } } };
    await expect(runtime.testConnection!(context)).rejects.toBe(failure);
    expect(f.requests).toEqual([]);
  });
  it('reports missing credentials without making a remote request', async () => {
    const f = fixture({});
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
    expect(f.requests).toEqual([]);
  });
});
