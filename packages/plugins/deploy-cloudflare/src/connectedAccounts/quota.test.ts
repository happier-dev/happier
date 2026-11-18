import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { cloudflareConnectedAccountRuntime, CLOUDFLARE_ACCOUNT_ID } from './runtime.js';
import { billingDeniedResponse, subscriptionsResponse } from './fixtures/subscriptionsResponses.js';

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
  it('names an exactly recognized Workers subscription with its product, so it never reads as another product\u2019s plan', async () => {
    const { context, requests } = readContext(subscriptionsResponse([{ rate_plan: { id: 'workers_paid', public_name: 'Workers Paid' } }]));
    await expect(cloudflareConnectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ observedAtMs: 2_000, planLabel: 'Workers Paid' });
    expect(requests).toEqual([`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`]);
  });

  it.each([
    { name: 'unmapped subscription', body: subscriptionsResponse([{ rate_plan: { id: 'pages_free' } }]), status: 200 },
    // Only exact ids map: a look-alike id or a name that merely mentions Workers is not a plan Happier knows.
    { name: 'look-alike plan id', body: subscriptionsResponse([{ rate_plan: { id: 'workers_paid_bundle' } }]), status: 200 },
    { name: 'name mentioning workers', body: subscriptionsResponse([{ rate_plan: { id: 'enterprise', public_name: 'Pro Workers add-on' } }]), status: 200 },
    { name: 'billing permission denied', body: billingDeniedResponse, status: 403 },
  ])('returns no plan label for $name', async ({ body, status }) => {
    const { context } = readContext(body, status);
    await expect(cloudflareConnectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ observedAtMs: 2_000, planLabel: null });
  });
});
