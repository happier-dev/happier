import type { ConnectedServiceCredentialRecordV1, ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';

import { mapCodexRateLimitResetCreditsToQuotaRecoveryCredits } from '@/backends/codex/quota/codexQuotaRecoveryCredits';
import {
  consumeCodexRateLimitResetCredit,
  DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL,
} from '@/backends/codex/quota/codexRateLimitResetCreditsClient';
import {
  ConnectedServiceQuotaFetchError,
  type ConnectedServiceQuotaFetcher,
  type ConnectedServiceQuotaFetcherDescriptor,
} from '@/daemon/connectedServices/quotas/types';
import { isRecord, normalizeNonEmptyString, resolveConnectedServiceQuotaAccountLabel } from '@/daemon/connectedServices/quotas/quotaNormalization';
import { parseRetryAfterHeader } from '@/daemon/connectedServices/quotas/normalization';
import { createOpenAiCodexSubscriptionFetcher } from './subscriptionFetcher';
import { mapCodexRateLimitPayloadToQuotaMeters } from './mapCodexRateLimitSnapshot';

function resolveAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  return resolveConnectedServiceQuotaAccountLabel(record);
}

function readProviderCodeFromBody(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const code = body.code ?? body.error_code ?? body.errorCode;
  if (typeof code === 'string' && code.trim()) return code.trim();
  const errorRecord = isRecord(body.error) ? body.error : null;
  if (errorRecord) {
    const innerCode = errorRecord.code ?? errorRecord.error_code;
    if (typeof innerCode === 'string' && innerCode.trim()) return innerCode.trim();
  }
  return null;
}

/**
 * Builds a quota-unknown meter placeholder for the given meterId.
 * Used when the endpoint is disabled or data is unavailable.
 */
function buildQuotaUnknownMeter(meterId: string, label: string): ConnectedServiceQuotaMeterV1 {
  return {
    meterId,
    label,
    used: null,
    limit: null,
    unit: 'unknown',
    utilizationPct: null,
    resetsAt: null,
    status: 'unavailable',
    details: { code: 'quota_unknown' },
  };
}

const DEFAULT_OPENAI_CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function parseNonEmptyStringEnv(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim();
  return trimmed ? trimmed : undefined;
}

function parseDisableQuotaEndpointEnv(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export const openAiCodexQuotaFetcherDescriptor: ConnectedServiceQuotaFetcherDescriptor = {
  loadSubscription: ({ env, staleAfterMs }) => createOpenAiCodexSubscriptionFetcher({
    staleAfterMs,
    disablePrivateEndpoint: parseDisableQuotaEndpointEnv(env.HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_SUBSCRIPTION_ENDPOINT),
  }),
  loadQuota: ({ env, staleAfterMs }) => createOpenAiCodexQuotaFetcher({
    usageUrl: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL),
    resetCreditsUrl: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_RESET_CREDITS_URL),
    staleAfterMs,
    userAgent: parseNonEmptyStringEnv(env.HAPPIER_CONNECTED_SERVICES_QUOTAS_USER_AGENT),
    disablePrivateEndpoint: parseDisableQuotaEndpointEnv(
      env.HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT,
    ),
  }),
};

export function createOpenAiCodexQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  resetCreditsUrl?: string | null;
  staleAfterMs?: number;
  userAgent?: string;
  /**
   * When true, skip the private endpoint entirely and return a quota_unknown
   * snapshot. Equivalent to setting HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT=1.
   * The per-call usageUrl override (if set) takes precedence over this flag.
   */
  disablePrivateEndpoint?: boolean;
}>): ConnectedServiceQuotaFetcher {
  const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim()
    ? params.usageUrl.trim()
    : DEFAULT_OPENAI_CODEX_USAGE_URL;
  const usingDefaultUsageUrl = usageUrl === DEFAULT_OPENAI_CODEX_USAGE_URL;
  const resetCreditsUrl = typeof params?.resetCreditsUrl === 'string' && params.resetCreditsUrl.trim()
    ? params.resetCreditsUrl.trim()
    : usingDefaultUsageUrl
      ? DEFAULT_CODEX_RATE_LIMIT_RESET_CREDITS_URL
      : null;
  const disablePrivateEndpoint = params?.disablePrivateEndpoint === true
    && usageUrl === DEFAULT_OPENAI_CODEX_USAGE_URL;
  const staleAfterMs = typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs) ? Math.max(1, Math.trunc(params.staleAfterMs)) : 300_000;
  const userAgent = params?.userAgent ?? 'happier';

  return {
    serviceId: 'openai-codex',
    pollPolicy: {
      minPollIntervalMs: 5 * 60_000,
    },
    consumeRecoveryCredit: async ({ record, idempotencyKey, providerCreditId, signal }) => {
      if (record.kind !== 'oauth') {
        throw new ConnectedServiceQuotaFetchError(
          'OpenAI Codex reset-credit consume requires an OAuth credential record',
          { quotaFetchErrorCode: 'missing_auth' },
        );
      }
      const creditId = typeof providerCreditId === 'string' && providerCreditId.trim()
        ? providerCreditId.trim()
        : undefined;
      const result = await consumeCodexRateLimitResetCredit({
        accessToken: record.oauth.accessToken,
        accountId: record.oauth.providerAccountId,
        ...(creditId ? { creditId } : {}),
        redeemRequestId: idempotencyKey,
        signal,
      });
      if (!result.ok) {
        throw new ConnectedServiceQuotaFetchError(
          `OpenAI reset-credit consume failed${typeof result.status === 'number' ? ` (${result.status})` : ''}`,
          {
            status: result.status,
            quotaFetchErrorCode: result.errorCode === 'codex_reset_credit_consume_network_error'
              ? 'network'
              : 'provider_backoff',
            providerCode: result.providerCode ?? result.errorCode,
            recoveryCreditConsumeOutcomeUnknown: result.errorCode === 'codex_reset_credit_consume_network_error'
              || (typeof result.status === 'number' && (result.status >= 500 || (result.status >= 200 && result.status < 300))),
          },
        );
      }
      switch (result.outcome.code) {
        case 'reset':
          return 'consumed';
        case 'already_redeemed':
          return 'already_consumed';
        case 'no_credit':
          return 'not_available';
        case 'nothing_to_reset':
          return 'nothing_to_reset';
      }
    },
    fetch: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') {
        throw new ConnectedServiceQuotaFetchError(
          'OpenAI Codex quota requires an OAuth credential record',
          { quotaFetchErrorCode: 'missing_auth' },
        );
      }

      // Kill-switch: skip private endpoint and return quota_unknown placeholder.
      // The usageUrl override (non-default URL) takes precedence — it is the documented
      // escape hatch and indicates the caller wants to use a specific endpoint.
      if (disablePrivateEndpoint) {
        return {
          v: 1,
          serviceId: record.serviceId,
          profileId: record.profileId,
          fetchedAt: now,
          staleAfterMs,
          planLabel: null,
          accountLabel: resolveAccountLabel(record),
          meters: [
            buildQuotaUnknownMeter('session', 'Session'),
            buildQuotaUnknownMeter('weekly', 'Weekly'),
          ],
        };
      }

      const headers = {
        'Authorization': `Bearer ${record.oauth.accessToken}`,
        ...(record.oauth.providerAccountId ? { 'ChatGPT-Account-Id': record.oauth.providerAccountId } : {}),
        'Accept': 'application/json',
        'User-Agent': userAgent,
      };
      let response: Response;
      try {
        response = await fetch(usageUrl, {
          method: 'GET',
          headers,
          signal,
        });
      } catch (fetchErr) {
        throw new ConnectedServiceQuotaFetchError(
          `OpenAI usage fetch network error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          { quotaFetchErrorCode: 'network' },
        );
      }

      if (!response.ok) {
        const retryAfter = parseRetryAfterHeader(response.headers?.get?.('retry-after'), { nowMs: now });

        // Attempt to read a provider code from the response body (best-effort).
        let providerCode: string | null = null;
        try {
          const body = await response.json() as unknown;
          providerCode = readProviderCodeFromBody(body);
        } catch {
          // Ignore body parse errors on non-ok responses.
        }

        const quotaFetchErrorCode = response.status === 401 ? 'auth_failure' : 'provider_backoff';
        throw new ConnectedServiceQuotaFetchError(
          `OpenAI usage fetch failed (${response.status}): ${response.statusText}`,
          {
            status: response.status,
            retryAfterMs: retryAfter.retryAfterMs,
            quotaFetchErrorCode,
            providerCode,
          },
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch (parseErr) {
        throw new ConnectedServiceQuotaFetchError(
          `OpenAI usage response body is malformed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          { quotaFetchErrorCode: 'malformed' },
        );
      }

      const data = isRecord(json) ? json : {};
      let rawResetCredits: unknown = data.rate_limit_reset_credits;
      if (resetCreditsUrl) {
        try {
          const resetCreditsResponse = await fetch(resetCreditsUrl, {
            method: 'GET',
            headers,
            signal,
          });
          if (resetCreditsResponse.ok) {
            rawResetCredits = await resetCreditsResponse.json();
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw error;
          }
        }
      }

      const planLabel = normalizeNonEmptyString(data.plan_type);
      const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
      const recoveryCredits = mapCodexRateLimitResetCreditsToQuotaRecoveryCredits(rawResetCredits);

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        fetchedAt: now,
        staleAfterMs,
        planLabel,
        accountLabel: resolveAccountLabel(record),
        ...(recoveryCredits ? { recoveryCredits } : {}),
        meters: [...mapCodexRateLimitPayloadToQuotaMeters({
          rate_limit: rateLimit,
          additional_rate_limits: data.additional_rate_limits,
          credits: data.credits,
          spend_control: data.spend_control,
        }, now, {
          legacyPrimary: { meterId: 'session', label: 'Session' },
          legacySecondary: { meterId: 'weekly', label: 'Weekly' },
        })],
      };
    },
  };
}
