import {
  parseClaudeProviderTimestampMs,
  parseClaudeUsageLimitReset,
  readClaudeAnthropicHeaderResetAtMs,
} from './reset.js';
import { parseTimestampMs } from '@happier-dev/plugin-sdk';

export type NormalizedClaudeUsageLimitDetails = Readonly<{
  v: 1;
  resetAtMs: number | null;
  retryAfterMs: number | null;
  limitCategory?: 'usage_limit' | 'rate_limit' | 'capacity';
  quotaScope: 'account' | 'provider';
  recoverability: 'wait';
  providerLimitId?: string;
  planType: string | null;
  utilization: number | null;
  overage: Readonly<{
    status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';
    resetAtMs: number | null;
    disabledReason?: string | null;
  }> | null;
  action: null;
  connectedService: null;
}>;

export type NormalizedClaudeRuntimeRateLimitMeter = Readonly<{
  meterId: string;
  label: string;
  utilizationPct: number | null;
  resetsAtMs: number | null;
  source: 'runtimeSignal';
}>;

export type NormalizedClaudeRuntimeRateLimitsObservation =
  | Readonly<{ status: 'not_loaded' }>
  | Readonly<{ status: 'loaded_empty'; meters: readonly [] }>
  | Readonly<{ status: 'loaded_data'; meters: readonly NormalizedClaudeRuntimeRateLimitMeter[] }>;

const RUNTIME_RATE_LIMIT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  five_hour: '5-hour',
  seven_day: 'Weekly',
  seven_day_oauth_apps: 'Weekly (OAuth apps)',
  seven_day_sonnet: 'Weekly (Sonnet)',
  seven_day_opus: 'Weekly (Opus)',
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readNonNegativeIntegerLike(value: unknown): number | null {
  if (typeof value === 'number') return readNonNegativeInteger(value);
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Number(value.trim());
  return readNonNegativeInteger(parsed);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') return parseTimestampMs(value);
  return parseClaudeProviderTimestampMs(value);
}

function readStatuslineRateLimits(value: unknown): unknown {
  const record = isRecord(value) ? value : null;
  const statusline = isRecord(record?.statusline) ? record.statusline : null;
  if (record && Object.prototype.hasOwnProperty.call(record, 'rate_limits')) return record.rate_limits;
  if (record && Object.prototype.hasOwnProperty.call(record, 'rateLimits')) return record.rateLimits;
  if (statusline && Object.prototype.hasOwnProperty.call(statusline, 'rate_limits')) return statusline.rate_limits;
  if (statusline && Object.prototype.hasOwnProperty.call(statusline, 'rateLimits')) return statusline.rateLimits;
  return undefined;
}

function readUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function buildRuntimeRateLimitMeter(
  meterId: string,
  raw: unknown,
): NormalizedClaudeRuntimeRateLimitMeter | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const utilizationPct = readUtilization(record.utilization ?? record.usedPercent ?? record.used_percent);
  const resetsAtMs = readTimestampMs(record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at);
  if (utilizationPct === null && resetsAtMs === null) return null;
  return {
    meterId,
    label: RUNTIME_RATE_LIMIT_LABELS[meterId] ?? meterId,
    utilizationPct,
    resetsAtMs,
    source: 'runtimeSignal',
  };
}

export function mapClaudeRuntimeRateLimitsToUsageObservation(
  value: unknown,
): NormalizedClaudeRuntimeRateLimitsObservation {
  const rawRateLimits = readStatuslineRateLimits(value);
  if (rawRateLimits === undefined) return { status: 'not_loaded' };

  const meters = Array.isArray(rawRateLimits)
    ? rawRateLimits.flatMap((entry, index) => {
        const record = isRecord(entry) ? entry : null;
        const meterId = readString(record?.meterId ?? record?.id ?? record?.name) ?? `meter_${index}`;
        const meter = buildRuntimeRateLimitMeter(meterId, entry);
        return meter ? [meter] : [];
      })
    : isRecord(rawRateLimits)
      ? Object.entries(rawRateLimits).flatMap(([meterId, rawMeter]) => {
          const meter = buildRuntimeRateLimitMeter(meterId, rawMeter);
          return meter ? [meter] : [];
        })
      : [];

  return meters.length > 0
    ? { status: 'loaded_data', meters }
    : { status: 'loaded_empty', meters: [] };
}

function readHttpStatus(value: unknown): number | null {
  const status = readNonNegativeIntegerLike(value);
  return status === null || status < 100 || status > 599 ? null : status;
}

function normalizeOverageStatus(value: unknown): 'allowed' | 'allowed_warning' | 'rejected' | 'unknown' {
  return value === 'allowed' || value === 'allowed_warning' || value === 'rejected' ? value : 'unknown';
}

function readHeaders(value: unknown): Record<string, unknown> | null {
  const response = isRecord(value) ? value.response : null;
  const headers = isRecord(response) ? response.headers : isRecord(value) ? value.headers : null;
  if (!isRecord(headers)) return null;
  const normalized: Record<string, unknown> = {};
  for (const [key, headerValue] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = headerValue;
  }
  return normalized;
}

function readFirstField(records: readonly Record<string, unknown>[], names: readonly string[]): unknown {
  for (const record of records) {
    for (const name of names) {
      if (record[name] !== undefined) return record[name];
    }
  }
  return undefined;
}

function collectSyntheticApiErrorRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const records = [record];
  const error = isRecord(record.error) ? record.error : null;
  if (error) records.push(error);
  const message = isRecord(record.message) ? record.message : null;
  if (message) {
    records.push(message);
    if (isRecord(message.error)) records.push(message.error);
  }
  const result = isRecord(record.result) ? record.result : null;
  if (result) {
    records.push(result);
    if (isRecord(result.error)) records.push(result.error);
  }
  return records;
}

function containsRateLimitEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /rate[ _-]?limit(?:ed)?/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsRateLimitEvidence);
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
  ].some(containsRateLimitEvidence);
}

function containsTransientThrottleEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /temporarily\s+limiting\s+requests/iu.test(value)
      || /not\s+your\s+usage\s+limit/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsTransientThrottleEvidence);
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
    value.text,
    value.content,
  ].some(containsTransientThrottleEvidence);
}

function containsProviderCapacityEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\b529\b/u.test(value) || /\boverloaded(?:_error)?\b/iu.test(value);
  }
  if (Array.isArray(value)) return value.some(containsProviderCapacityEvidence);
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
    value.text,
    value.content,
  ].some(containsProviderCapacityEvidence);
}

function readSyntheticProviderLimitId(records: readonly Record<string, unknown>[]): string | undefined {
  if (records.some(containsProviderCapacityEvidence)) return 'server_overloaded';
  if (records.some(containsTransientThrottleEvidence)) return 'transient';
  for (const names of [
    ['providerLimitId', 'provider_limit_id', 'limit', 'limitType', 'limit_type'],
    ['code', 'error', 'type', 'kind'],
  ] as const) {
    for (const record of records) {
      for (const name of names) {
        const text = readString(record[name]);
        if (!text) continue;
        if (containsRateLimitEvidence(text)) return 'rate_limit';
        if (
          name === 'providerLimitId'
          || name === 'provider_limit_id'
          || name === 'limit'
          || name === 'limitType'
          || name === 'limit_type'
        ) {
          return text;
        }
      }
    }
  }
  return undefined;
}

function readSyntheticResetAtMs(records: readonly Record<string, unknown>[]): number | null {
  return readTimestampMs(readFirstField(records, [
    'resetAtMs',
    'reset_at_ms',
    'resetsAt',
    'resets_at',
    'resetAt',
    'reset_at',
    'quotaResetTimeStamp',
    'quotaResetTimestamp',
    'quota_reset_timestamp',
  ]));
}

function readSyntheticRetryAfterMs(records: readonly Record<string, unknown>[]): number | null {
  return readNonNegativeIntegerLike(readFirstField(records, [
    'retryAfterMs',
    'retry_after_ms',
    'retry-after-ms',
  ]));
}

function mapSyntheticClaudeApiErrorToUsageDetails(
  record: Record<string, unknown>,
): NormalizedClaudeUsageLimitDetails | null {
  const records = collectSyntheticApiErrorRecords(record);
  const status = readHttpStatus(readFirstField(records, [
    'apiErrorStatus',
    'api_error_status',
    'errorStatus',
    'error_status',
    'status',
    'statusCode',
    'status_code',
  ]));
  const hasRateLimitEvidence = containsRateLimitEvidence(record);
  const hasTransientThrottleEvidence = containsTransientThrottleEvidence(record);
  const hasProviderCapacityEvidence = status === 529 || containsProviderCapacityEvidence(record);
  const hasCompatibleStatus = status === null || status === 429 || status === 529;
  const isAssistantApiError =
    (record.type === 'assistant' || record.type === 'assistant_response')
    && record.isApiErrorMessage === true
    && (hasRateLimitEvidence || hasTransientThrottleEvidence || hasProviderCapacityEvidence || status === 429)
    && hasCompatibleStatus;
  const isResultApiError =
    record.type === 'result'
    && hasCompatibleStatus
    && (status === 429 || hasRateLimitEvidence || hasTransientThrottleEvidence || hasProviderCapacityEvidence)
    && (
      status === 429
      || status === 529
      || record.is_error === true
      || readString(record.subtype)?.includes('error') === true
    );
  const isStructuredCapacityError = hasProviderCapacityEvidence && status === 529;
  if (!isAssistantApiError && !isResultApiError && !isStructuredCapacityError) return null;

  const timing = parseClaudeUsageLimitReset({ body: record, nowMs: Date.now() });
  const resetAtMs = readSyntheticResetAtMs(records) ?? timing.resetAtMs;
  const retryAfterMs = readSyntheticRetryAfterMs(records) ?? timing.retryAfterMs;
  const providerLimitId = hasProviderCapacityEvidence
    ? 'server_overloaded'
    : readSyntheticProviderLimitId(records) ?? (status === 429 ? 'rate_limit' : undefined);

  return {
    v: 1,
    resetAtMs,
    retryAfterMs,
    ...(hasProviderCapacityEvidence
      ? { limitCategory: 'capacity' as const }
      : hasTransientThrottleEvidence
        ? { limitCategory: 'rate_limit' as const }
        : {}),
    quotaScope: hasProviderCapacityEvidence || hasTransientThrottleEvidence ? 'provider' : 'account',
    recoverability: 'wait',
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: null,
    utilization: readUtilization(readFirstField(records, ['utilization', 'usedPercent', 'used_percent'])),
    overage: null,
    action: null,
    connectedService: null,
  };
}

function mapClaudeHeadersToUsageDetails(value: unknown): NormalizedClaudeUsageLimitDetails | null {
  const headers = readHeaders(value);
  if (!headers) return null;
  const timing = parseClaudeUsageLimitReset({ headers, body: value, nowMs: Date.now() });
  const resetAtMs =
    readClaudeAnthropicHeaderResetAtMs(headers)
    ?? timing.resetAtMs;
  if (timing.retryAfterMs === null && resetAtMs === null) return null;
  return {
    v: 1,
    resetAtMs,
    retryAfterMs: timing.retryAfterMs,
    quotaScope: 'account',
    recoverability: 'wait',
    planType: null,
    utilization: null,
    overage: null,
    action: null,
    connectedService: null,
  };
}

export function mapClaudeRateLimitEventToUsageDetails(event: unknown): NormalizedClaudeUsageLimitDetails | null {
  const record = isRecord(event) ? event : null;
  if (record?.type !== 'rate_limit_event') {
    return record
      ? mapSyntheticClaudeApiErrorToUsageDetails(record) ?? mapClaudeHeadersToUsageDetails(event)
      : mapClaudeHeadersToUsageDetails(event);
  }
  const info = isRecord(record.rate_limit_info) ? record.rate_limit_info : null;
  if (!info) return null;
  const status = readString(info.status);
  if (status !== 'rejected') return null;
  const rateLimitType = readString(info.rateLimitType ?? info.rate_limit_type);
  const overageStatusRaw = info.overageStatus ?? info.overage_status;
  const overageStatus = normalizeOverageStatus(overageStatusRaw);
  const overageResetAtMs = readTimestampMs(info.overageResetsAt ?? info.overage_resets_at);
  const overageDisabledReason = readString(info.overageDisabledReason ?? info.overage_disabled_reason);

  return {
    v: 1,
    resetAtMs: readTimestampMs(info.resetsAt ?? info.resets_at),
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'wait',
    ...(rateLimitType ? { providerLimitId: rateLimitType } : {}),
    planType: null,
    utilization: readUtilization(info.utilization),
    overage: overageStatusRaw === undefined && overageResetAtMs === null && overageDisabledReason === null
      ? null
      : {
          status: overageStatus,
          resetAtMs: overageResetAtMs,
          ...(overageDisabledReason ? { disabledReason: overageDisabledReason } : {}),
        },
    action: null,
    connectedService: null,
  };
}
