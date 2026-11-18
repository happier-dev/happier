import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { cloudflareConnectedAccountRuntime, CLOUDFLARE_ACCOUNT_ID } from './runtime.js';

const accountId = 'a'.repeat(32);

function readContext(response: unknown, status = 200): { context: ConnectedAccountReadContext; requests: string[] } {
  const requests: string[] = [];
  const service = { pluginId: 'happier.deploy.cloudflare', localId: CLOUDFLARE_ACCOUNT_ID } as const;
  const context = {
    plugin: { id: service.pluginId, version: '0.0.0' },
    contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'background' as const, invokedAtMs: 2_000, signal: new AbortController().signal,
    account: { service, accountId },
    configuration: { target: { kind: 'account' as const, account: { service, accountId }, modeId: 'token' },
      revision: 'revision-1', values: { accountId }, async getSecret() { return null; } },
    credentials: { async get() { return 'token'; } },
    services: { http: { async request(request: { url: string }) {
      requests.push(request.url);
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) };
    } } },
  } as unknown as ConnectedAccountReadContext;
  return { context, requests };
}

describe('Cloudflare account plan quota', () => {
  it('maps a Workers paid subscription', async () => {
    const { context, requests } = readContext({ success: true, result: [{ rate_plan: { id: 'workers_paid' } }] });
    await expect(cloudflareConnectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ observedAtMs: 2_000, planLabel: 'Paid' });
    expect(requests).toEqual([`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`]);
  });

  it.each([
    { name: 'unmapped subscription', body: { success: true, result: [{ rate_plan: { id: 'pages_free' } }] }, status: 200 },
    { name: 'billing permission denied', body: { success: false, errors: [{ code: 10000 }] }, status: 403 },
  ])('returns no plan label for $name', async ({ body, status }) => {
    const { context } = readContext(body, status);
    await expect(cloudflareConnectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ observedAtMs: 2_000, planLabel: null });
  });
});
