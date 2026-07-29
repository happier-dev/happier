import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
  ConnectedServiceQuotaMeterV1,
  ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1,
  ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import type { PluginConnectedAccountRuntime } from '@happier-dev/plugin-sdk/runtime';
import type { CodexRuntimeFetch } from '../runtimeFetch.js';

import { mapCodexRateLimitResetCredits } from './rateLimitResetCredits.js';
import {
  OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL,
  OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL,
  consumeCodexRateLimitResetCredit,
  fetchCodexRateLimitResetCredits,
} from './rateLimitResetCreditsClient.js';

export const OPENAI_CODEX_DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizePct(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAtMs(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num > 1_000_000_000_000 ? Math.trunc(num) : Math.trunc(num * 1000);
}

export function parseOpenAiCodexConnectedAccountQuotaLimits(
  value: unknown,
): Awaited<
  ReturnType<NonNullable<PluginConnectedAccountRuntime['quota']>>
>['limits'] {
  const data = isRecord(value) ? value : {};
  const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : null;
  const primary = rateLimit && isRecord(rateLimit.primary_window) ? rateLimit.primary_window : null;
  const secondary = rateLimit && isRecord(rateLimit.secondary_window) ? rateLimit.secondary_window : null;
  return [
    ['session', primary],
    ['weekly', secondary],
  ].map(([id, window]) => {
    const usageWindow = isRecord(window) ? window : null;
    const used = normalizePct(usageWindow?.used_percent);
    const resetsAtMs = normalizeResetAtMs(usageWindow?.reset_at);
    return {
      id: String(id),
      ...(used === null ? {} : { used, remaining: 100 - used }),
      ...(resetsAtMs === null ? {} : { resetsAtMs }),
    };
  });
}

function resolveConnectedServiceQuotaAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind !== 'oauth') return null;
  return normalizeNonEmptyString(record.oauth.providerEmail)
    ?? normalizeNonEmptyString(record.oauth.providerAccountId);
}

export type CodexQuotaFetcher = Readonly<{
  serviceId: ConnectedServiceId;
  loadQuota: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    signal: AbortSignal;
  }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
  consumeRecoveryCredit?: (params: Readonly<{
    record: ConnectedServiceCredentialRecordV1;
    now: number;
    idempotencyKey: string;
    providerCreditId?: string;
    signal: AbortSignal;
  }>) => Promise<Exclude<ConnectedServiceQuotaRecoveryCreditConsumeReceiptStatusV1, 'unknown_after_timeout'>>;
}>;

export type CodexQuotaFetcherDescriptor = Readonly<{
  id: string;
  createFetcher: (params: Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    staleAfterMs: number;
    userAgent?: string;
  }>) => CodexQuotaFetcher;
}>;

function headersToRecord(headers: Headers | undefined): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function toRequestBody(value: unknown): BodyInit | null | undefined {
  if (value === undefined || value === null) return value;
  if (
    typeof value === 'string'
    || value instanceof URLSearchParams
    || value instanceof ArrayBuffer
    || value instanceof Blob
    || value instanceof FormData
    || value instanceof ReadableStream
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function defaultRuntimeFetch(): CodexRuntimeFetch {
  return async ({ url, method, headers, body, signal }) => {
    const response = await fetch(url, {
      method,
      headers,
      body: toRequestBody(body),
      signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      text: async () => await response.text(),
      json: async () => await response.json(),
      arrayBuffer: async () => await response.arrayBuffer(),
    };
  };
}

/**
 * Builds a quota-unknown meter placeholder for the given meterId.
 * Used when the private endpoint is disabled via the kill switch.
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

export function createOpenAiCodexQuotaFetcher(params?: Readonly<{
  usageUrl?: string;
  resetCreditsUrl?: string;
  resetCreditConsumeUrl?: string;
  staleAfterMs?: number;
  userAgent?: string;
  /**
   * When true, skip the private endpoint entirely and return a quota_unknown
   * snapshot without any network IO. Equivalent to setting
   * HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT=1.
   * The usageUrl override (if set) takes precedence over this flag.
   */
  disablePrivateEndpoint?: boolean;
  runtimeFetch?: CodexRuntimeFetch;
}>): CodexQuotaFetcher {
  const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim().length > 0
    ? params.usageUrl.trim()
    : OPENAI_CODEX_DEFAULT_USAGE_URL;
  const disablePrivateEndpoint = params?.disablePrivateEndpoint === true
    && usageUrl === OPENAI_CODEX_DEFAULT_USAGE_URL;
  const resetCreditsUrl = typeof params?.resetCreditsUrl === 'string' && params.resetCreditsUrl.trim().length > 0
    ? params.resetCreditsUrl.trim()
    : usageUrl === OPENAI_CODEX_DEFAULT_USAGE_URL
      ? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDITS_URL
      : null;
  const resetCreditConsumeUrl = typeof params?.resetCreditConsumeUrl === 'string' && params.resetCreditConsumeUrl.trim().length > 0
    ? params.resetCreditConsumeUrl.trim()
    : usageUrl === OPENAI_CODEX_DEFAULT_USAGE_URL
      ? OPENAI_CODEX_DEFAULT_RATE_LIMIT_RESET_CREDIT_CONSUME_URL
      : null;
  const staleAfterMs = typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
    ? Math.max(1, Math.trunc(params.staleAfterMs))
    : 300_000;
  const userAgent = params?.userAgent ?? 'happier';
  const runtimeFetch = params?.runtimeFetch ?? defaultRuntimeFetch();

  return {
    serviceId: 'openai-codex',
    consumeRecoveryCredit: async ({ record, idempotencyKey, providerCreditId, signal }) => {
      if (record.kind !== 'oauth') {
        throw new Error('OpenAI reset-credit consume requires OAuth credentials');
      }
      if (!resetCreditConsumeUrl) {
        throw new Error('OpenAI reset-credit consume endpoint unavailable');
      }
      const outcome = await consumeCodexRateLimitResetCredit({
        accessToken: record.oauth.accessToken,
        accountId: record.oauth.providerAccountId,
        idempotencyKey,
        providerCreditId,
        consumeUrl: resetCreditConsumeUrl,
        userAgent,
        signal,
        runtimeFetch,
      });
      switch (outcome.code) {
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
    loadQuota: async ({ record, now, signal }) => {
      if (record.kind !== 'oauth') return null;
      if (!usageUrl) return null;

      // Kill-switch: never perform network IO against the private endpoint; return
      // a quota_unknown placeholder snapshot instead. The usageUrl override (a
      // non-default URL) takes precedence — it is the documented escape hatch and
      // indicates the caller wants a specific endpoint probed.
      if (disablePrivateEndpoint) {
        return {
          v: 1,
          serviceId: record.serviceId,
          profileId: record.profileId,
          ...(record.oauth.providerAccountId ? { activeAccountId: record.oauth.providerAccountId } : {}),
          fetchedAt: now,
          staleAfterMs,
          planLabel: null,
          accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
          meters: [
            buildQuotaUnknownMeter('session', 'Session'),
            buildQuotaUnknownMeter('weekly', 'Weekly'),
          ],
        };
      }

      const response = await runtimeFetch({
        url: usageUrl,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${record.oauth.accessToken}`,
          ...(record.oauth.providerAccountId ? { 'ChatGPT-Account-Id': record.oauth.providerAccountId } : {}),
          'Accept': 'application/json',
          'User-Agent': userAgent,
        },
        signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI usage fetch failed (${response.status}): ${response.statusText || 'HTTP error'}`);
      }

      const json: unknown = await response.json();
      const data = isRecord(json) ? json : {};
      let rawResetCredits: unknown;
      if (resetCreditsUrl) {
        try {
          rawResetCredits = await fetchCodexRateLimitResetCredits({
            accessToken: record.oauth.accessToken,
            accountId: record.oauth.providerAccountId,
            resetCreditsUrl,
            userAgent,
            signal,
            runtimeFetch,
          });
        } catch {
          rawResetCredits = undefined;
        }
      }
      const recoveryCredits = mapCodexRateLimitResetCredits({
        rawUsage: data,
        rawResetCredits,
      });

      const planLabel = normalizeNonEmptyString(data.plan_type);
      const connectedAccountLimits = parseOpenAiCodexConnectedAccountQuotaLimits(data);

      return {
        v: 1,
        serviceId: record.serviceId,
        profileId: record.profileId,
        ...(record.oauth.providerAccountId ? { activeAccountId: record.oauth.providerAccountId } : {}),
        fetchedAt: now,
        staleAfterMs,
        planLabel,
        accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
        ...(recoveryCredits ? { recoveryCredits } : {}),
        meters: connectedAccountLimits.map((limit) => ({
          meterId: limit.id,
          label: limit.id === 'session' ? 'Session' : 'Weekly',
          used: null,
          limit: null,
          unit: 'unknown',
          utilizationPct: limit.used ?? null,
          resetsAt: limit.resetsAtMs ?? null,
          status: limit.used === undefined ? 'unavailable' : 'ok',
          details: {},
        })),
      };
    },
  };
}

function readNonEmptyEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/**
 * Returns true when the kill-switch env var is set to a truthy value ("1", "true", "yes").
 *
 * HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT=1
 *   When set, the private Codex quota endpoint (chatgpt.com/backend-api/wham/usage) is
 *   skipped; the fetcher returns a quota_unknown snapshot instead. This allows the
 *   endpoint to be disabled in the field without a release.
 *
 * The usage URL override (HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL) takes
 * precedence — it is the documented escape hatch for routing to a different URL.
 */
function readDisableCodexQuotaEndpointEnv(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = (env.HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export const openAiCodexQuotaFetcherDescriptor: CodexQuotaFetcherDescriptor = {
  id: 'openai-codex',
  createFetcher: ({ env, staleAfterMs, userAgent }) => createOpenAiCodexQuotaFetcher({
    usageUrl: readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL'),
    resetCreditsUrl: readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_RESET_CREDITS_URL'),
    resetCreditConsumeUrl: readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_RESET_CREDIT_CONSUME_URL'),
    staleAfterMs,
    userAgent,
    disablePrivateEndpoint: readDisableCodexQuotaEndpointEnv(env),
  }),
};
