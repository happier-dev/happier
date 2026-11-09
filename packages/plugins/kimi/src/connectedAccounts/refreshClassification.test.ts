import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { claudeSubscriptionConnectedAccountRuntime } from '../../../claude/src/connectedAccounts/claudeSubscriptionRuntime.js';
import { antigravityConnectedAccountRuntime } from '../../../antigravity/src/connectedAccounts/antigravityConnectedAccountRuntime.js';

describe.each([
  { name: 'Claude', modeId: 'oauth', runtime: claudeSubscriptionConnectedAccountRuntime },
  { name: 'Antigravity', modeId: 'oauth-personal', runtime: antigravityConnectedAccountRuntime },
])('$name refresh evidence', ({ modeId, runtime }) => {
  it.each([
    { httpStatus: 403, error: 'policy_refusal', status: 'outcomeUnknown' },
    { httpStatus: 401, error: 'temporarily_unavailable', status: 'outcomeUnknown' },
    { httpStatus: 400, error: 'invalid_grant', status: 'reconnectRequired' },
  ])('retains root credentials for HTTP $httpStatus $error', async row => {
    const values = new Map([['accessToken', 'fake-old'], ['refreshToken', 'fake-root']]);
    const staged = new Map<string, string>();
    // HTTP and credential persistence are the boundaries; both real exchange paths run.
    const context = { configuration: { target: { modeId } }, invokedAtMs: 1800000000000,
      signal: new AbortController().signal,
      credentials: { async get(key: string) { return values.get(key) ?? null; } },
      stagedCredentials: { async set(key: string, value: string) { staged.set(key, value); }, async delete(key: string) { staged.delete(key); } },
      services: { http: { async request(input: { url: string }) { return { status: row.httpStatus, headers: {}, finalUrl: input.url, body: new TextEncoder().encode(JSON.stringify({ error: row.error })) }; } } },
    } as Parameters<ConnectedAccountRuntime['refresh']>[0];
    expect(await runtime.refresh(context)).toMatchObject({ status: row.status });
    expect(staged.size).toBe(0);
    expect(values.get('refreshToken')).toBe('fake-root');
  });
});
