import { isClaudeSidechainRuntimeEvidence } from '../utils/sessionHookAttribution';
import type { ConnectedServiceLimitCategoryV1 } from '@happier-dev/protocol';

import { parseProviderResetAt, parseProviderTimestampMs } from '@/daemon/connectedServices/quotas/normalization';

import { readSessionHookSidechainAgentId } from '../utils/sessionHookAttribution';

export type NormalizedProviderUsageLimitDetailsV1 = Readonly<{
  v: 1;
  resetAtMs: number | null;
  retryAfterMs: number | null;
  limitCategory?: Extract<ConnectedServiceLimitCategoryV1, 'usage_limit' | 'rate_limit' | 'capacity' | 'unknown'>;
  quotaScope: 'account' | 'workspace' | 'organization' | 'model' | 'provider' | 'unknown';
  recoverability: 'wait' | 'switch_account' | 'manual' | 'unknown';
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
  sourceProviderAccountId?: string | null;
  sourceProviderOrganizationId?: string | null;
  /**
   * Set when the evidence row was imported from a subagent transcript (`isSidechain: true`).
   * Sidechain limits are real account-level evidence (quota snapshots may consume them) but
   * must never fail the PARENT turn nor trigger runtime-auth recovery (incident Jun-11 H-B).
   */
  sourcedFromSidechain?: true;
}>;

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
  const integer = readNonNegativeInteger(value);
  if (integer !== null) return integer < 10_000_000_000 ? integer * 1000 : integer;
  return parseProviderTimestampMs(value);
}

function readUtilization(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function readUtilizationPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const percent = value >= 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, percent));
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
  if (Array.isArray(value)) {
    return value.some(containsRateLimitEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.errors,
    value.result,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
  ].some(containsRateLimitEvidence);
}

function containsClaudeUsageLimitEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /usage\s+limit|limit\s+reached/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsClaudeUsageLimitEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.errors,
    value.result,
    value.code,
    value.type,
    value.kind,
    value.message,
    value.detail,
    value.details,
    value.description,
    value.text,
    value.content,
  ].some(containsClaudeUsageLimitEvidence);
}

const CLAUDE_PIPE_EPOCH_RESET_PATTERN = /limit\s+reached\s*\|\s*(\d{10,13})\b/iu;

function collectClaudeEvidenceText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectClaudeEvidenceText(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of [
    'error',
    'errors',
    'message',
    'detail',
    'details',
    'description',
    'text',
    'content',
    'result',
    'rate_limit_info',
  ]) {
    collectClaudeEvidenceText(value[key], output);
  }
}

/**
 * Best-effort reset/retry timing extraction from a raw Claude provider payload (INC-4): the
 * canonical pipe-epoch CLI shape ("Claude AI usage limit reached|<epoch>") wins, then structured
 * fields/headers, then textual evidence ("try again in 2 hours", TUI reset text) anywhere in the
 * assistant/result content the shared parser does not walk.
 */
export function resolveClaudeUsageLimitResetTiming(
  value: unknown,
  nowMs: number,
): Readonly<{ resetAtMs: number | null; retryAfterMs: number | null }> {
  const candidates: string[] = [];
  collectClaudeEvidenceText(value, candidates);
  for (const candidate of candidates) {
    const match = CLAUDE_PIPE_EPOCH_RESET_PATTERN.exec(candidate);
    const resetAtMs = match ? readTimestampMs(Number(match[1])) : null;
    if (resetAtMs !== null) return { resetAtMs, retryAfterMs: null };
  }
  const direct = parseProviderResetAt({ body: value, nowMs });
  if (direct.resetAtMs !== null || direct.retryAfterMs !== null) return direct;
  for (const candidate of candidates) {
    const parsed = parseProviderResetAt({ body: { message: candidate }, nowMs });
    if (parsed.resetAtMs !== null || parsed.retryAfterMs !== null) return parsed;
  }
  return { resetAtMs: null, retryAfterMs: null };
}

function containsTransientThrottleEvidence(value: unknown): boolean {
  if (typeof value === 'string') {
    return /temporarily\s+limiting\s+requests/iu.test(value)
      || /not\s+your\s+usage\s+limit/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsTransientThrottleEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.errors,
    value.result,
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
    return /\b529\b/u.test(value)
      || /\boverloaded(?:_error)?\b/iu.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsProviderCapacityEvidence);
  }
  if (!isRecord(value)) return false;
  return [
    value.error,
    value.errors,
    value.result,
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
  // An error code identifies the rejection, not the exhausted allowance. Unknown
  // allowance identity must remain unknown so selected pool limits do not exclude it.
  for (const record of records) {
    for (const name of ['providerLimitId', 'provider_limit_id', 'limit', 'limitType', 'limit_type']) {
      const text = readString(record[name]);
      if (text) return text;
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

function mapSyntheticClaudeApiErrorToUsageDetails(record: Record<string, unknown>): NormalizedProviderUsageLimitDetailsV1 | null {
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
  const hasUsageLimitEvidence = containsClaudeUsageLimitEvidence(record);
  const hasProviderCapacityEvidence = status === 529 || containsProviderCapacityEvidence(record);
  const hasCompatibleStatus = status === null || status === 429 || status === 529;
  const isAssistantApiError =
    record.type === 'assistant' &&
    record.isApiErrorMessage === true &&
    (hasRateLimitEvidence || hasUsageLimitEvidence || hasProviderCapacityEvidence || status === 429) &&
    hasCompatibleStatus;
  const isResultApiError =
    record.type === 'result' &&
    hasCompatibleStatus &&
    (status === 429 || hasRateLimitEvidence || hasUsageLimitEvidence || hasProviderCapacityEvidence) &&
    (
      status === 429 ||
      status === 529 ||
      record.is_error === true ||
      readString(record.subtype)?.includes('error') === true
    );
  if (!isAssistantApiError && !isResultApiError) return null;

  const timing = resolveClaudeUsageLimitResetTiming(record, Date.now());
  const resetAtMs = readSyntheticResetAtMs(records) ?? timing.resetAtMs;
  const retryAfterMs = readSyntheticRetryAfterMs(records) ?? timing.retryAfterMs;
  const providerLimitId = readSyntheticProviderLimitId(records);

  return {
    v: 1,
    resetAtMs,
    retryAfterMs,
    ...(hasProviderCapacityEvidence ? { limitCategory: 'capacity' as const } : {}),
    quotaScope: 'account',
    recoverability: 'wait',
    ...(providerLimitId ? { providerLimitId } : {}),
    planType: null,
    utilization: readUtilization(readFirstField(records, ['utilization', 'usedPercent', 'used_percent'])),
    overage: null,
    action: null,
    connectedService: null,
  };
}

function mapClaudeHeadersToUsageDetails(value: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const headers = readHeaders(value);
  if (!headers) return null;
  const timing = parseProviderResetAt({ headers, body: value, nowMs: Date.now() });
  const resetAtMs =
    readTimestampMs(headers['anthropic-ratelimit-tokens-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-requests-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-input-tokens-reset'])
    ?? readTimestampMs(headers['anthropic-ratelimit-output-tokens-reset'])
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

export function mapClaudeStopFailureErrorToUsageDetails(
  errorType: string | null | undefined,
): NormalizedProviderUsageLimitDetailsV1 | null {
  if (readString(errorType) !== 'rate_limit') return null;
  return {
    v: 1,
    resetAtMs: null,
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'wait',
    planType: null,
    utilization: null,
    overage: null,
    action: null,
    connectedService: null,
  };
}

export function mapClaudeStopFailureHookToUsageDetails(hook: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const record = isRecord(hook) ? hook : null;
  if (!record) return null;
  // Hook payloads attribute subagent activity via `agent_id` (not the transcript-row
  // `isSidechain` flag): a sidechain usage-limit StopFailure must carry the sidechain
  // marker so it never fails the PARENT turn (shared predicate, sessionHookAttribution).
  return markHookSidechainSourcedUsageDetails(record, mapStopFailureHookRecordToUsageDetails(record));
}

function markHookSidechainSourcedUsageDetails(
  record: Record<string, unknown>,
  details: NormalizedProviderUsageLimitDetailsV1 | null,
): NormalizedProviderUsageLimitDetailsV1 | null {
  if (!details || readSessionHookSidechainAgentId(record) === null) return details;
  return { ...details, sourcedFromSidechain: true };
}

function mapStopFailureHookRecordToUsageDetails(record: Record<string, unknown>): NormalizedProviderUsageLimitDetailsV1 | null {
  const hookEventName = readString(record.hook_event_name ?? record.hookEventName);
  if (hookEventName !== 'StopFailure') return null;
  const direct = mapClaudeStopFailureErrorToUsageDetails(readString(record.error) ?? readString(record.error_type));
  const lastAssistantMessage = readString(record.last_assistant_message ?? record.lastAssistantMessage);
  const assistantTiming = lastAssistantMessage
    ? parseProviderResetAt({
        body: { message: lastAssistantMessage },
        nowMs: Date.now(),
      })
    : { resetAtMs: null, retryAfterMs: null };
  const fromAssistant = !lastAssistantMessage
    ? null
    : mapSyntheticClaudeApiErrorToUsageDetails({
    type: 'assistant',
    isApiErrorMessage: true,
    text: lastAssistantMessage,
    content: lastAssistantMessage,
    error: record.error,
    error_type: record.error_type,
    apiErrorStatus: record.apiErrorStatus
      ?? record.api_error_status
      ?? record.errorStatus
      ?? record.error_status
      ?? record.status,
  });
  if (direct && (assistantTiming.resetAtMs !== null || assistantTiming.retryAfterMs !== null)) {
    return {
      ...direct,
      resetAtMs: assistantTiming.resetAtMs,
      retryAfterMs: assistantTiming.retryAfterMs,
    };
  }
  if (!fromAssistant) return direct;
  return direct
    ? {
        ...direct,
        ...fromAssistant,
        providerLimitId: fromAssistant.providerLimitId ?? direct.providerLimitId,
      }
    : fromAssistant;
}

function markSidechainSourcedUsageDetails(
  record: Record<string, unknown> | null,
  details: NormalizedProviderUsageLimitDetailsV1 | null,
): NormalizedProviderUsageLimitDetailsV1 | null {
  if (!details || !isClaudeSidechainRuntimeEvidence(record)) return details;
  return { ...details, sourcedFromSidechain: true };
}

/** Availability telemetry does not establish that the parent operation failed. */
export function mapClaudeProviderFailureToUsageDetails(event: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  if (!isRecord(event) || isClaudeSidechainRuntimeEvidence(event)) return null;
  return mapSyntheticClaudeApiErrorToUsageDetails(event);
}

export function mapClaudeRateLimitEventToUsageDetails(event: unknown): NormalizedProviderUsageLimitDetailsV1 | null {
  const record = isRecord(event) ? event : null;
  if (record?.type !== 'rate_limit_event') {
    return markSidechainSourcedUsageDetails(
      record,
      record
        ? mapSyntheticClaudeApiErrorToUsageDetails(record) ?? mapClaudeHeadersToUsageDetails(event)
        : mapClaudeHeadersToUsageDetails(event),
    );
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
  const declaredResetAtMs = readTimestampMs(info.resetsAt ?? info.resets_at);
  // INC-4: a rejected event without resets_at must not surface a timing-less limit when the
  // payload carries parseable reset/retry evidence elsewhere.
  const fallbackTiming = declaredResetAtMs === null
    ? resolveClaudeUsageLimitResetTiming(record, Date.now())
    : null;

  return markSidechainSourcedUsageDetails(record, {
    v: 1,
    resetAtMs: declaredResetAtMs ?? fallbackTiming?.resetAtMs ?? null,
    retryAfterMs: fallbackTiming?.retryAfterMs ?? null,
    // RD-CLD-5: the rejection is authoritative usage-limit evidence — the surfaced meter's
    // utilization (possibly a different window than the one that rejected) must not demote it.
    limitCategory: 'usage_limit',
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
  });
}

/**
 * Claude reports a unified window's usage as the fraction of the window used — 0-1, above 1 once
 * usage runs past the cap. Rounded to one decimal percent, as Claude's own statusline does.
 */
function readUnifiedWindowUsedPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 1000) / 10));
}

function buildPassiveQuotaEvidence(input: Readonly<{
  providerLimitId: string | null;
  utilization: number;
  resetAtMs: number | null;
}>): NormalizedProviderUsageLimitDetailsV1 {
  return {
    v: 1,
    resetAtMs: input.resetAtMs,
    retryAfterMs: null,
    quotaScope: 'account',
    recoverability: 'wait',
    ...(input.providerLimitId ? { providerLimitId: input.providerLimitId } : {}),
    planType: null,
    utilization: input.utilization,
    overage: null,
    action: null,
    connectedService: null,
  };
}

/**
 * Every usage window a Claude `rate_limit_event` reports, one entry per window, whatever its
 * status. Current Claude Code reports every window under `rate_limit_info.unifiedWindows` and
 * leaves the top-level `utilization` unset; older builds only carry the surfaced window's
 * top-level `utilization`.
 */
export function readClaudeRateLimitEventWindows(event: unknown): readonly NormalizedProviderUsageLimitDetailsV1[] {
  const record = isRecord(event) ? event : null;
  if (record?.type !== 'rate_limit_event') return [];
  const info = isRecord(record.rate_limit_info) ? record.rate_limit_info : null;
  if (!info) return [];

  const unifiedWindows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
  const windowEvidence = Object.entries(unifiedWindows).flatMap(([windowId, window]) => {
    if (!isRecord(window)) return [];
    const utilization = readUnifiedWindowUsedPercent(window.utilization);
    if (utilization === null) return [];
    return [buildPassiveQuotaEvidence({
      providerLimitId: windowId,
      utilization,
      resetAtMs: readTimestampMs(window.resetsAt),
    })];
  });
  if (windowEvidence.length > 0) return windowEvidence;

  const utilization = readUtilizationPercent(info.utilization);
  if (utilization === null) return [];
  return [buildPassiveQuotaEvidence({
    providerLimitId: readString(info.rateLimitType ?? info.rate_limit_type),
    utilization,
    resetAtMs: readTimestampMs(info.resetsAt ?? info.resets_at),
  })];
}

/** Availability is quota evidence even when an optional allowance is rejected. */
export function mapClaudeRateLimitEventToQuotaEvidence(event: unknown): readonly NormalizedProviderUsageLimitDetailsV1[] {
  const record = isRecord(event) ? event : null;
  if (record && record.type !== 'rate_limit_event' && isClaudeSidechainRuntimeEvidence(record)) {
    const details = mapSyntheticClaudeApiErrorToUsageDetails(record);
    return details ? [{ ...details, sourcedFromSidechain: true }] : [];
  }
  const info = isRecord(record?.rate_limit_info) ? record.rate_limit_info : null;
  const status = readString(info?.status);
  return status === 'allowed' || status === 'allowed_warning' || status === 'rejected'
    ? readClaudeRateLimitEventWindows(event) : [];
}
