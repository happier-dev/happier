import { describe, expect, it } from 'vitest';
import { isGithubCopilotCompatibleToken } from './tokenKinds.js';
import { refreshGithubCopilotCredential } from './copilot.js';
import { githubConnectedAccountRuntime } from './connectedAccountRuntime.js';
import type { ConnectedAccountAuthenticationContext, ConnectedAccountMutationContext } from '@happier-dev/plugin-sdk/connected-accounts';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fixture(responses: Array<{ status: number; body: unknown }>, clientId: string | null = 'happier-public-client') {
  const values = new Map<string, string>();
  const stagedValues = new Map<string, string>();
  const stagedDeletes = new Set<string>();
  const requests: Array<{ url: string; fields: URLSearchParams }> = [];
  const signal = new AbortController().signal;
  const storage = (entries: Map<string, string>, deleted?: Set<string>) => ({
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: string) => { entries.set(key, value); },
    delete: async (key: string) => { entries.delete(key); deleted?.add(key); },
  });
  const store = storage(values);
  // The host invocation boilerplate is outside this HTTP/credential boundary fixture.
  const context = {
    signal, invokedAtMs: 1000,
    attempt: { kind: 'connect', attemptId: 'test' },
    configuration: { getPublicOAuthClient: async () => clientId ? { clientId, scopes: ['read:user'] } : null },
    attemptCredentials: store, credentials: store, stagedCredentials: storage(stagedValues, stagedDeletes),
    services: { http: { request: async (input: { url: string; body?: Uint8Array }, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      requests.push({ url: input.url, fields: new URLSearchParams(new TextDecoder().decode(input.body)) });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected HTTP request');
      return { status: response.status, headers: {}, body: json(response.body), finalUrl: input.url };
    } } },
  } as unknown as ConnectedAccountAuthenticationContext & ConnectedAccountMutationContext;
  return { context, values, stagedValues, stagedDeletes, requests };
}
const grant = { device_code: 'fake-device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
function deviceMode() {
  const mode = githubConnectedAccountRuntime.authentication.modes['copilot-device'];
  if (!mode || mode.kind !== 'oauthDeviceCode') throw new Error('GitHub Copilot device mode is unavailable');
  return mode;
}

describe('GitHub Copilot device authentication', () => {
  it('requires operator client configuration without a borrowed app or request', async () => {
    const f = fixture([], null);
    expect(await deviceMode().begin(f.context)).toMatchObject({ status: 'unavailable', diagnostic: { code: 'github_copilot_client_unavailable' } });
    expect(f.requests).toHaveLength(0);
    expect(f.values.size).toBe(0);
  });

  it.each([true, false])('completes into the same record with one identity confirmation and only issued renewal material (expiring=%s)', async expiring => {
    const f = fixture([{ status: 200, body: grant },
      { status: 200, body: { error: 'authorization_pending' } },
      { status: 200, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'gho_fake', ...(expiring ? { refresh_token: 'fake-refresh', expires_in: 3600 } : {}) } },
      { status: 200, body: { id: 123, login: 'octocat' } }]);
    const mode = deviceMode();
    expect(await mode.begin(f.context)).toMatchObject({ status: 'awaitingDeviceAuthorization', userCode: 'ABCD', pollIntervalMs: 5000 });
    expect(await mode.poll(f.context)).toEqual({ status: 'pending', retryAfterMs: 5000 });
    expect(await mode.poll(f.context)).toEqual({ status: 'pending', retryAfterMs: 10000 });
    expect(await mode.poll(f.context)).toMatchObject({ status: 'connected', credentialKind: 'oauth', accountId: '123' });
    expect(f.values.get('token')).toBe('gho_fake');
    expect(f.values.get('refreshToken')).toBe(expiring ? 'fake-refresh' : undefined);
    expect(f.values.has('expiresAtMs')).toBe(expiring);
    expect(f.values.get('oauthClientId')).toBe('happier-public-client');
    expect(f.requests.map(request => request.url)).toEqual(['https://github.com/login/device/code', ...Array(3).fill('https://github.com/login/oauth/access_token'), 'https://api.github.com/user']);
    expect(f.requests[1]?.fields.get('client_id')).toBe('happier-public-client');
    expect(f.requests[1]?.fields.get('device_code')).toBe('fake-device');
    expect([...f.values.values()].join('\n')).not.toContain('fake-device');
  });

  it('makes disabled device flow configuration unavailable and cancellation clears the pending secret', async () => {
    const disabled = fixture([{ status: 200, body: { error: 'device_flow_disabled' } }]);
    const mode = deviceMode();
    expect(await mode.begin(disabled.context)).toMatchObject({ status: 'unavailable', diagnostic: { code: 'github_copilot_device_flow_disabled' } });
    const pending = fixture([{ status: 200, body: grant }]);
    await mode.begin(pending.context);
    await mode.cancel(pending.context);
    expect(pending.values.size).toBe(0);
    expect(await mode.poll(pending.context)).toMatchObject({ status: 'unavailable' });
    expect(pending.requests).toHaveLength(1);
  });

  it('retains cancellation rather than converting it to an unavailable account', async () => {
    const f = fixture([{ status: 200, body: grant }]);
    const controller = new AbortController(); controller.abort();
    await expect(deviceMode().begin(f.context, { signal: controller.signal })).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
});

describe('GitHub issued device-token refresh', () => {
  it('does not invent renewal for manual or non-expiring grants', async () => {
    const f = fixture([]);
    expect(await refreshGithubCopilotCredential(f.context)).toBeNull();
    expect(f.requests).toHaveLength(0);
  });
  it.each([true, false])('stages issued access material and retains correct refresh authority (rotated=%s)', async rotated => {
    const f = fixture([{ status: 200, body: { access_token: 'ghu_rotated', ...(rotated ? { refresh_token: 'refresh-rotated' } : {}), expires_in: 7200 } }]);
    f.values.set('token', 'ghu_original');
    f.values.set('refreshToken', 'refresh-original'); f.values.set('oauthClientId', 'original-client');
    expect(await refreshGithubCopilotCredential(f.context)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    expect(f.stagedValues.get('token')).toBe('ghu_rotated');
    expect(f.stagedValues.get('refreshToken')).toBe(rotated ? 'refresh-rotated' : 'refresh-original');
    expect(f.values.get('token')).toBe('ghu_original');
    expect(f.requests[0]?.fields.get('client_id')).toBe('original-client');
    expect(f.requests[0]?.fields.get('grant_type')).toBe('refresh_token');
  });
  it('removes the old expiry when the refreshed access grant has no expiry', async () => {
    const f = fixture([{ status: 200, body: { access_token: 'ghu_nonexpiring' } }]);
    f.values.set('token', 'ghu_original');
    f.values.set('refreshToken', 'refresh-original'); f.values.set('oauthClientId', 'original-client');
    f.values.set('expiresAtMs', '1000');
    expect(await refreshGithubCopilotCredential(f.context)).toMatchObject({ status: 'connected', credentialKind: 'oauth' });
    // The host applies set/delete mutations over the authoritative credential snapshot.
    const committed = new Map(f.values);
    for (const [key, value] of f.stagedValues) committed.set(key, value);
    for (const key of f.stagedDeletes) committed.delete(key);
    expect(committed.get('token')).toBe('ghu_nonexpiring');
    expect(committed.has('expiresAtMs')).toBe(false);
    expect(f.values.get('expiresAtMs')).toBe('1000');
  });
  it.each([[400, 'bad_refresh_token', 'reconnectRequired'], [403, undefined, 'unavailable'], [503, undefined, 'unavailable']] as const)(
    'classifies refresh %s/%s without discarding SCM credentials', async (status, error, expected) => {
      const f = fixture([{ status, body: error ? { error } : {} }]);
      f.values.set('token', 'github_pat_existing'); f.values.set('refreshToken', 'refresh-original'); f.values.set('oauthClientId', 'original-client');
      expect(await refreshGithubCopilotCredential(f.context)).toMatchObject({ status: expected });
      expect(f.values.get('token')).toBe('github_pat_existing');
    });
});

describe('GitHub Copilot compatible token kinds', () => {
  it.each(['github_pat_fake', 'gho_fake', 'ghu_fake'])('accepts documented kind %s without entitlement evidence', token => {
    expect(isGithubCopilotCompatibleToken(token)).toBe(true);
  });
  it.each(['ghp_fake', 'ghs_fake', 'unknown', ''])('does not claim compatibility for %s', token => {
    expect(isGithubCopilotCompatibleToken(token)).toBe(false);
  });
});
