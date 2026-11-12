import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { cursorConnectedAccountRuntime as runtime, cursorPortableAccountRuntime } from './portableRuntime.js';

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
      // GetMeResponse: auth_id (field 1) and user_id (field 2), from the pinned CLI schema.
      return { status: outcome, headers: { 'content-type': 'application/proto' }, body: new Uint8Array([10, 4, 102, 97, 107, 101, 16, 42]) };
    } }) },
  } as ReadContext;
  return { context, requests, abortDuringRequest() { abortOnRequest = true; } };
}

describe('Cursor no-usage connection check', () => {
  it('reads the subscription profile using the characterized empty Connect request', async () => {
    const f = fixture({ credentialKind: 'oauth', accessToken: 'synthetic-token', refreshToken: 'synthetic-refresh' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toEqual([expect.objectContaining({ url: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe', method: 'POST', redirect: 'error',
      headers: expect.objectContaining({ Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/proto', 'Connect-Protocol-Version': '1' }), body: new Uint8Array() })]);
  });
  it('exposes the same profile read in the Account artifact', async () => {
    const f = fixture({ credentialKind: 'oauth', accessToken: 'synthetic-token' });
    expect(await cursorPortableAccountRuntime.testConnection!(f.context)).toMatchObject({ status: 'ok' });
    expect(f.requests).toHaveLength(1);
  });
  it('explains API-key unavailability without exchanging the key for tokens', async () => {
    const f = fixture({ apiKey: 'synthetic-token' });
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'unsupported', reason: expect.any(String) });
    expect(f.requests).toEqual([]);
  });

  it.each([
    [401, 'needsReauth'], [403, 'unsupported'], [429, 'networkUnavailable'], [503, 'networkUnavailable'],
    [new Error('synthetic-token must never escape'), 'networkUnavailable'],
  ] as const)('reports a secret-free %s failure as %s', async (outcome, status) => {
    const f = fixture({ credentialKind: 'oauth', accessToken: 'synthetic-token' }, outcome);
    const result = await runtime.testConnection!(f.context);
    expect(result).toMatchObject({ status, code: expect.any(String), reason: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('synthetic-token');
    expect(f.requests).toHaveLength(1);
  });
  it('preserves cancellation instead of reporting a connection failure', async () => {
    const failure = new Error('cancelled');
    const f = fixture({ credentialKind: 'oauth', accessToken: 'synthetic-token' }, failure);
    f.abortDuringRequest();
    await expect(runtime.testConnection!(f.context)).rejects.toBe(failure);
  });
  it('reports missing credentials without making a remote request', async () => {
    const f = fixture({});
    expect(await runtime.testConnection!(f.context)).toMatchObject({ status: 'needsReauth' });
    expect(f.requests).toEqual([]);
  });
});
