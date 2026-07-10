import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

export type OpenCodeUsageLimitRetryTiming = Readonly<{
  retryAfterMs: number | null;
  resetAtMs: number | null;
}>;

type OpenCodeRuntimeLimitCategory = 'usage_limit' | 'rate_limit';

export type OpenCodeUsageLimitRetryParser = (params: Readonly<{
  headers: unknown;
  body: unknown;
  nowMs: number;
}>) => OpenCodeUsageLimitRetryTiming;

export type OpenCodeUsageLimitClassification = Readonly<{
  kind: 'usage_limit' | 'rate_limit';
  limitCategory: OpenCodeRuntimeLimitCategory;
  retryAfterMs: number | null;
  resetAtMs: number | null;
  quotaScope: 'account' | 'workspace' | 'unknown';
  providerLimitId: string | null;
  action: Readonly<{ kind: 'open_url'; url: string }> | null;
}>;

function readErrorName(record: Readonly<Record<string, unknown>>): string | null {
  return readString(record.name)
    ?? readString(record.code)
    ?? readString(record.type)
    ?? readString(record.reason);
}

export function classifyOpenCodeUsageLimitError(params: Readonly<{
  providerErrorPath: boolean;
  error: unknown;
  now?: number;
  parseResetAt: OpenCodeUsageLimitRetryParser;
}>): OpenCodeUsageLimitClassification | null {
  if (!params.providerErrorPath) return null;
  const record = isRecord(params.error) ? params.error : null;
  if (!record) return null;

  const name = readErrorName(record);
  if (name !== 'FreeUsageLimitError' && name !== 'GoUsageLimitError') return null;

  const retry = params.parseResetAt({
    headers: record.headers,
    body: record,
    nowMs: params.now ?? Date.now(),
  });

  if (name === 'FreeUsageLimitError') {
    return {
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      retryAfterMs: retry.retryAfterMs,
      resetAtMs: retry.resetAtMs,
      quotaScope: 'account',
      providerLimitId: 'free_tier_limit',
      action: null,
    };
  }

  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const action = isRecord(record.action) ? record.action : {};
  const actionUrl = readString(action.url);

  return {
    kind: 'rate_limit',
    limitCategory: 'rate_limit',
    retryAfterMs: retry.retryAfterMs,
    resetAtMs: retry.resetAtMs,
    quotaScope: readString(metadata.workspace) ? 'workspace' : 'account',
    providerLimitId: readString(metadata.limitName ?? metadata.limit_name) ?? 'account_rate_limit',
    action: actionUrl ? { kind: 'open_url', url: actionUrl } : null,
  };
}

export const OPEN_CODE_USAGE_LIMIT_RECOVERY = Object.freeze({
  providerId: 'opencode',
  fallbackBackoffEnvKey: 'HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_FALLBACK_BACKOFF_MS',
  maxAttemptsEnvKey: 'HAPPIER_OPENCODE_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS',
  defaultFallbackBackoffMs: 600_000,
  defaultMaxAttempts: 3,
} as const);
