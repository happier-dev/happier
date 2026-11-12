import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { createXaiConnectedAccountRuntime } from './runtime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
const runtime = createXaiConnectedAccountRuntime();

type ReadContext = Parameters<ConnectedAccountRuntime['status']>[0];
function fixture(values: Readonly<Record<string, string>>, outcome: number | Error = 200, body: unknown = { data: [], config: {} }) {
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
      return { status: outcome, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } }) },
  } as ReadContext;
  return { context, requests, abortDuringRequest() { abortOnRequest = true; } };
}

describe('xAI no-usage connection check', () => {
  it.each([
    ['api-key', 'https://api.x.ai/v1/models'],
    ['subscription', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'],
  ] as const)('checks %s on its own authenticated read without inference or refresh', async (mode, url) => {
    const f = fixture({ xaiCredential: JSON.stringify({ mode, accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh' }) });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toEqual([expect.objectContaining({ url, method: 'GET', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token', ...(mode === 'subscription' ? { 'X-XAI-Token-Auth': 'xai-grok-cli' } : {}) }) })]);
    const permission = PLUGIN_MANIFEST.hostAccess.required.find(entry => entry.id === 'xai-account-network');
    expect(permission).toMatchObject({ scope: { targets: expect.arrayContaining([{ kind: 'fixedOrigin', origin: new URL(url).origin }]) } });
  });

  it('preserves a characterized policy refusal without calling it expired authentication', async () => {
    const f = fixture({ xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'synthetic-token' }) }, 403, { error: 'BLOCKED_REASON_NO_LOGS' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', code: 'BLOCKED_REASON_NO_LOGS' });
  });

  it.each([
    [401, 'needsReauth'], [403, 'unsupported'], [429, 'networkUnavailable'], [503, 'networkUnavailable'],
    [new Error('synthetic-token must never escape'), 'networkUnavailable'],
  ] as const)('reports a secret-free %s failure as %s', async (outcome, status) => {
    const f = fixture({ xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'synthetic-token' }) }, outcome);
    const result = await runtime.testConnection!(f.context);
    expect(result).toMatchObject({ status, code: expect.any(String), reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(f.requests).toHaveLength(1);
  });
  it('preserves cancellation instead of reporting a connection failure', async () => {
    const failure = new Error('cancelled');
    const f = fixture({ xaiCredential: JSON.stringify({ mode: 'subscription', accessToken: 'synthetic-token' }) }, failure);
    f.abortDuringRequest();
    await expect(runtime.testConnection!(f.context)).rejects.toBe(failure);
  });
  it('preserves credential custody failures without asking for reauthentication', async () => {
    const f = fixture({});
    const failure = new Error('credential custody unavailable');
    const context = { ...f.context, credentials: { async get() { throw failure; } } };
    await expect(runtime.testConnection!(context)).rejects.toBe(failure);
    expect(f.requests).toEqual([]);
  });
  it('reports missing credentials without making a remote request', async () => {
    const f = fixture({});
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
    expect(f.requests).toEqual([]);
  });
});
