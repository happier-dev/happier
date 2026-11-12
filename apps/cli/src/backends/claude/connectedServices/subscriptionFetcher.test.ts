import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createConnectedServiceAccountFetchers } from '@/daemon/connectedServices/quotas/createConnectedServiceQuotaFetchers';
import { claudeSubscriptionQuotaFetcherDescriptor } from './quotaFetcher';
import { createClaudeSubscriptionStatusFetcher } from './subscriptionFetcher';

const now = Date.parse('2026-11-01T12:00:00Z');
const signal = new AbortController().signal;
function credential(kind: 'oauth' | 'token' = 'oauth') {
  if (kind === 'token') {
    return buildConnectedServiceCredentialRecord({ now, serviceId: 'claude-subscription', profileId: 'setup', kind: 'token',
      token: { token: 'setup-token', providerAccountId: null, providerEmail: null } });
  }
  return buildConnectedServiceCredentialRecord({
    now, serviceId: 'claude-subscription', profileId: 'work', kind: 'oauth', expiresAt: now + 60_000,
    oauth: { accessToken: 'test-token', refreshToken: 'test-refresh', idToken: null, scope: null,
      tokenType: null, providerAccountId: 'user-1', providerEmail: null },
  });
}
function profile(organization: Record<string, unknown>) {
  return { account: { uuid: 'user-1', email_address: 'member@example.test' }, organization: { uuid: 'org-1', ...organization } };
}

describe('Claude subscription reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads subscription status from the OAuth profile without inventing a period end or renewal', async () => {
    const fetchMock = vi.fn(async () => Response.json(profile({
      organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x',
      subscription_status: 'active', billing_type: 'stripe_subscription', subscription_created_at: '2025-01-01T00:00:00Z',
    })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await createClaudeSubscriptionStatusFetcher({ staleAfterMs: 123_000 }).fetch({ record: credential(), now, signal });
    expect(result).toEqual({ observedAtMs: now, staleAfterMs: 123_000, status: 'subscribed', renewal: 'unknown' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/profile', expect.objectContaining({ method: 'GET', signal }));
  });

  it.each([
    [{ subscription_status: 'canceled', organization_type: 'claude_max' }, 'none'],
    [{ organization_type: 'claude_pro' }, 'subscribed'],
  ])('projects %o as %s', async (organization, status) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(profile(organization))));
    await expect(createClaudeSubscriptionStatusFetcher().fetch({ record: credential(), now, signal }))
      .resolves.toMatchObject({ status, renewal: 'unknown' });
  });

  it('rejects a profile with no subscription evidence instead of labelling it unsubscribed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(profile({ subscription_status: 'mystery' }))));
    await expect(createClaudeSubscriptionStatusFetcher().fetch({ record: credential(), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'malformed' });
  });

  it('surfaces provider rejection and Retry-After backoff', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    await expect(createClaudeSubscriptionStatusFetcher().fetch({ record: credential(), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'auth_failure', status: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '600' } })));
    await expect(createClaudeSubscriptionStatusFetcher().fetch({ record: credential(), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'provider_backoff', status: 429, retryAfterMs: 600_000 });
  });

  it('never fetches for setup tokens or a disabled private endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(createClaudeSubscriptionStatusFetcher().fetch({ record: credential('token'), now, signal }))
      .rejects.toMatchObject({ quotaFetchErrorCode: 'missing_auth' });
    await expect(createClaudeSubscriptionStatusFetcher({ disablePrivateEndpoint: true }).fetch({ record: credential(), now, signal }))
      .resolves.toMatchObject({ status: 'unavailable', renewal: 'unknown' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is composed from the Claude descriptor and follows the configured usage host', async () => {
    const fetchMock = vi.fn(async () => Response.json(profile({ subscription_status: 'active' })));
    vi.stubGlobal('fetch', fetchMock);
    const { subscriptionFetchers } = createConnectedServiceAccountFetchers({
      HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: 'https://quota.happier.test/anthropic/oauth/usage',
    }, [claudeSubscriptionQuotaFetcherDescriptor]);
    expect(subscriptionFetchers.map((fetcher) => fetcher.serviceId)).toEqual(['claude-subscription']);
    await subscriptionFetchers[0]!.fetch({ record: credential(), now, signal });
    expect(fetchMock).toHaveBeenCalledWith('https://quota.happier.test/anthropic/oauth/profile', expect.anything());
  });
});
