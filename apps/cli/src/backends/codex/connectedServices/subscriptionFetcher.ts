import { z } from 'zod';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceSubscriptionFetcher } from '@/daemon/connectedServices/quotas/types';
import { parseRetryAfterHeader } from '@/daemon/connectedServices/quotas/normalization';
import { lazySchema } from '@happier-dev/protocol';

const DEFAULT_SUBSCRIPTION_URL = 'https://chatgpt.com/backend-api/subscriptions';
// This private endpoint currently rejects the generic CLI UA. Keep this policy local
// to subscriptions; it does not change the Codex quota endpoint's request identity.
const SUBSCRIPTION_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const subscriptionResponseSchema = lazySchema(() => z.object({
  active_until: z.string().datetime({ offset: true }).transform((value) => Date.parse(value)),
  will_renew: z.unknown().optional(),
}));

export function createOpenAiCodexSubscriptionFetcher(params?: Readonly<{
  subscriptionUrl?: string;
  staleAfterMs?: number;
  userAgent?: string;
  disablePrivateEndpoint?: boolean;
}>): ConnectedServiceSubscriptionFetcher {
  const subscriptionUrl = params?.subscriptionUrl?.trim() || DEFAULT_SUBSCRIPTION_URL;
  const disabled = params?.disablePrivateEndpoint === true && subscriptionUrl === DEFAULT_SUBSCRIPTION_URL;
  const staleAfterMs = typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
    ? Math.max(1, Math.trunc(params.staleAfterMs)) : 300_000;
  return {
    serviceId: 'openai-codex',
    pollPolicy: { minPollIntervalMs: 5 * 60_000 },
    fetch: async ({ record, now, signal }) => {
      signal.throwIfAborted();
      if (disabled) return { observedAtMs: now, staleAfterMs, status: 'unavailable', renewal: 'unknown' };
      if (record.kind !== 'oauth' || !record.oauth.providerAccountId?.trim() || !record.oauth.accessToken.trim()) {
        throw new ConnectedServiceQuotaFetchError('OpenAI subscription requires an identified OAuth account', {
          quotaFetchErrorCode: 'missing_auth',
        });
      }
      const url = new URL(subscriptionUrl);
      url.searchParams.set('account_id', record.oauth.providerAccountId.trim());
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: 'GET', signal, redirect: 'error',
          headers: {
            Authorization: `Bearer ${record.oauth.accessToken}`,
            Accept: 'application/json', Origin: 'https://chatgpt.com', Referer: 'https://chatgpt.com/',
            'User-Agent': params?.userAgent?.trim() || SUBSCRIPTION_USER_AGENT,
          },
        });
      } catch {
        signal.throwIfAborted();
        throw new ConnectedServiceQuotaFetchError('OpenAI subscription request failed', { quotaFetchErrorCode: 'network' });
      }
      if (!response.ok) {
        throw new ConnectedServiceQuotaFetchError('OpenAI subscription request failed', {
          quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : 'provider_backoff',
          status: response.status,
          retryAfterMs: parseRetryAfterHeader(response.headers.get('retry-after'), { nowMs: now }).retryAfterMs,
        });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        signal.throwIfAborted();
        throw new ConnectedServiceQuotaFetchError('OpenAI subscription response was invalid', { quotaFetchErrorCode: 'malformed' });
      }
      const parsed = subscriptionResponseSchema.safeParse(body);
      if (!parsed.success) {
        // Empty responses have no evidenced no-subscription meaning. Do not erase a
        // prior observation or label an account unsubscribed from an unknown shape.
        throw new ConnectedServiceQuotaFetchError('OpenAI subscription response was invalid', { quotaFetchErrorCode: 'malformed' });
      }
      return {
        observedAtMs: now, staleAfterMs, status: 'subscribed',
        renewal: parsed.data.will_renew === true ? 'on' : parsed.data.will_renew === false ? 'off' : 'unknown',
        currentPeriodEndAtMs: parsed.data.active_until,
      };
    },
  };
}
