import { CLAUDE_OAUTH_PROFILE_URL } from '@happier-dev/agents';

import { resolveClaudeCodeUserAgent } from '@/backends/claude/utils/claudeCodeUserAgent';
import { fetchClaudeSubscriptionProfileContext } from '@/daemon/connectedServices/descriptors/connectedAccountDescriptors';
import { parseRetryAfterHeader } from '@/daemon/connectedServices/quotas/normalization';
import { ConnectedServiceQuotaFetchError, type ConnectedServiceSubscriptionFetcher } from '@/daemon/connectedServices/quotas/types';

/**
 * Subscription status from the OAuth profile. Claude OAuth tokens cannot read the renewal
 * or period end (those need claude.ai browser cookies), so this reader never reports either.
 */
export function createClaudeSubscriptionStatusFetcher(params?: Readonly<{
  /** Custom usage endpoint; the profile is read from its sibling `./profile`, like the quota reader. */
  usageUrl?: string;
  staleAfterMs?: number;
  userAgent?: string;
  disablePrivateEndpoint?: boolean;
}>): ConnectedServiceSubscriptionFetcher {
  const usageUrl = params?.usageUrl?.trim();
  const profileUrl = usageUrl ? new URL('./profile', usageUrl).toString() : CLAUDE_OAUTH_PROFILE_URL;
  const disabled = params?.disablePrivateEndpoint === true && !usageUrl;
  const staleAfterMs = typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
    ? Math.max(1, Math.trunc(params.staleAfterMs)) : 300_000;
  const userAgent = resolveClaudeCodeUserAgent(params?.userAgent);
  return {
    serviceId: 'claude-subscription',
    // Same cadence as the Codex subscription reader. This reads the profile, never the rate-limited usage endpoint.
    pollPolicy: { minPollIntervalMs: 5 * 60_000 },
    fetch: async ({ record, now, signal }) => {
      signal.throwIfAborted();
      if (disabled) return { observedAtMs: now, staleAfterMs, status: 'unavailable', renewal: 'unknown' };
      if (record.kind !== 'oauth' || !record.oauth.accessToken.trim()) {
        throw new ConnectedServiceQuotaFetchError('Claude subscription requires an OAuth account', { quotaFetchErrorCode: 'missing_auth' });
      }
      const observed: { response: Response | null } = { response: null };
      let profile: Awaited<ReturnType<typeof fetchClaudeSubscriptionProfileContext>>;
      try {
        profile = await fetchClaudeSubscriptionProfileContext({
          accessToken: record.oauth.accessToken,
          expectedProviderAccountId: record.oauth.providerAccountId,
          profileUrl,
          signal,
          fetcher: async (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('User-Agent', userAgent);
            observed.response = await fetch(url, { ...init, headers });
            return observed.response;
          },
        });
      } catch {
        signal.throwIfAborted();
        const response = observed.response;
        throw new ConnectedServiceQuotaFetchError(
          response ? 'Claude subscription response was invalid' : 'Claude subscription request failed',
          { quotaFetchErrorCode: response ? 'malformed' : 'network' },
        );
      }
      const response = observed.response;
      if (profile.status === 'rejected' || profile.status === 'identity_mismatch') {
        throw new ConnectedServiceQuotaFetchError('Claude subscription request was rejected', {
          quotaFetchErrorCode: 'auth_failure', status: profile.status === 'rejected' ? profile.providerStatus : null,
        });
      }
      if (profile.status === 'unavailable') {
        if (response && !response.ok) {
          throw new ConnectedServiceQuotaFetchError('Claude subscription request failed', {
            quotaFetchErrorCode: 'provider_backoff', status: response.status,
            retryAfterMs: parseRetryAfterHeader(response.headers.get('retry-after'), { nowMs: now }).retryAfterMs,
          });
        }
        throw new ConnectedServiceQuotaFetchError('Claude subscription response was invalid', { quotaFetchErrorCode: 'malformed' });
      }
      if (!profile.subscriptionStatus) {
        // Unknown shapes have no evidenced no-subscription meaning; keep the prior observation.
        throw new ConnectedServiceQuotaFetchError('Claude subscription response was invalid', { quotaFetchErrorCode: 'malformed' });
      }
      return { observedAtMs: now, staleAfterMs, status: profile.subscriptionStatus, renewal: 'unknown' };
    },
  };
}
