import {
  buildSessionRuntimeIssueV1,
  type BuildSessionRuntimeIssueV1Input,
  type SessionRuntimeIssueV1,
  type SessionRuntimeUsageLimitDetailsV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';

type ClaudeLimitCategory = NonNullable<SessionRuntimeUsageLimitDetailsV1['limitCategory']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function readNonNegativeIntegerLike(value: unknown): number | null {
  if (typeof value === 'number') return readNonNegativeInteger(value);
  const text = readString(value);
  if (!text) return null;
  return readNonNegativeInteger(Number(text));
}

function readHttpStatus(value: unknown): number | null {
  const status = readNonNegativeIntegerLike(value);
  return status === null || status < 100 || status > 599 ? null : status;
}

function collectEvidenceParts(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceParts(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const key of [
    'type',
    'code',
    'kind',
    'error',
    'message',
    'detail',
    'description',
    'text',
    'content',
    'last_assistant_message',
    'lastAssistantMessage',
  ]) {
    collectEvidenceParts(value[key], output);
  }
}

function readFirstField(records: readonly Record<string, unknown>[], names: readonly string[]): unknown {
  for (const record of records) {
    for (const name of names) {
      if (record[name] !== undefined) return record[name];
    }
  }
  return undefined;
}

function collectEvidenceRecords(value: unknown): Record<string, unknown>[] {
  const record = isRecord(value) ? value : null;
  if (!record) return [];
  const records = [record];
  for (const key of ['error', 'message', 'result', 'response', 'payload', 'data']) {
    const nested = isRecord(record[key]) ? record[key] : null;
    if (nested) records.push(nested);
  }
  return records;
}

function containsRateLimitEvidence(value: unknown): boolean {
  const parts: string[] = [];
  collectEvidenceParts(value, parts);
  return /rate[ _-]?limit(?:ed)?|temporarily\s+limiting\s+requests/iu.test(parts.join(' '));
}

function containsCapacityEvidence(value: unknown): boolean {
  const parts: string[] = [];
  collectEvidenceParts(value, parts);
  return /\b529\b|overloaded(?:_error)?/iu.test(parts.join(' '));
}

function readStatusEvidence(value: unknown): number | null {
  const records = collectEvidenceRecords(value);
  return readHttpStatus(readFirstField(records, [
    'apiErrorStatus',
    'api_error_status',
    'errorStatus',
    'error_status',
    'status',
    'statusCode',
    'status_code',
  ]));
}

function readRetryAfterMs(value: unknown): number | null {
  const records = collectEvidenceRecords(value);
  const retryAfterMs = readNonNegativeIntegerLike(readFirstField(records, [
    'retryAfterMs',
    'retry_after_ms',
    'retry-after-ms',
  ]));
  if (retryAfterMs !== null) return retryAfterMs;

  const retryAfter = readFirstField(records, ['retryAfter', 'retry_after', 'retry-after']);
  const seconds = readNonNegativeIntegerLike(retryAfter);
  if (seconds !== null) return seconds * 1000;
  const dateText = readString(retryAfter);
  if (!dateText) return null;
  const dateMs = Date.parse(dateText);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

function readResetAtMs(value: unknown): number | null {
  const records = collectEvidenceRecords(value);
  const raw = readFirstField(records, [
    'resetAtMs',
    'reset_at_ms',
    'resetsAt',
    'resets_at',
    'resetAt',
    'reset_at',
    'quotaResetTimestamp',
    'quota_reset_timestamp',
  ]);
  const numeric = readNonNegativeIntegerLike(raw);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const text = readString(raw);
  if (!text) return null;
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) && dateMs >= 0 ? dateMs : null;
}

function readPreview(value: unknown, fallback?: string | null): string | undefined {
  const parts: string[] = [];
  collectEvidenceParts(value, parts);
  const preview = parts.join(' ').replace(/\s+/gu, ' ').trim() || fallback?.trim() || '';
  return preview ? preview.slice(0, 2_000) : undefined;
}

function createUsageDetails(params: Readonly<{
  category: ClaudeLimitCategory;
  providerLimitId: string;
  evidence: unknown;
}>): SessionRuntimeUsageLimitDetailsV1 {
  return {
    v: 1,
    resetAtMs: readResetAtMs(params.evidence),
    retryAfterMs: readRetryAfterMs(params.evidence),
    limitCategory: params.category,
    quotaScope: 'account',
    recoverability: 'wait',
    providerLimitId: params.providerLimitId,
    planType: null,
    utilization: null,
    overage: null,
    action: null,
    connectedService: null,
  };
}

function buildClaudeIssue(
  issue: BuildSessionRuntimeIssueV1Input,
  evidence: unknown,
  fallbackMessage?: string | null,
): SessionRuntimeIssueV1 {
  return buildSessionRuntimeIssueV1({
    ...issue,
    sanitizedPreview: readPreview(evidence, fallbackMessage),
  });
}

export function mapClaudeProviderFailureToUsageDetails(
  evidence: unknown,
): SessionRuntimeUsageLimitDetailsV1 | null {
  const status = readStatusEvidence(evidence);
  if (status === 529 || containsCapacityEvidence(evidence)) {
    return createUsageDetails({
      category: 'capacity',
      providerLimitId: 'server_overloaded',
      evidence,
    });
  }
  if (status === 429 || containsRateLimitEvidence(evidence)) {
    return createUsageDetails({
      category: 'rate_limit',
      providerLimitId: 'rate_limit',
      evidence,
    });
  }
  return null;
}

export function buildClaudeRuntimeIssue(params: Readonly<{
  evidence: unknown;
  occurredAt: number;
  fallbackMessage?: string | null;
}>): SessionRuntimeIssueV1 {
  const usageLimit = mapClaudeProviderFailureToUsageDetails(params.evidence);
  if (usageLimit?.limitCategory === 'capacity') {
    return buildClaudeIssue({
      code: 'claude.provider.capacity',
      source: 'agent_status_error',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage);
  }
  if (usageLimit) {
    return buildClaudeIssue({
      code: 'claude.usage_limit',
      source: 'usage_limit',
      occurredAt: params.occurredAt,
      agentId: 'claude',
      usageLimit,
    }, params.evidence, params.fallbackMessage);
  }
  return buildClaudeIssue({
    code: 'claude.provider.failure',
    source: 'agent_session_error',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, params.evidence, params.fallbackMessage);
}

export function buildClaudeProcessExitRuntimeIssue(params: Readonly<{
  occurredAt: number;
  exitCode: number | null;
  signal: string | null;
  turnWasInFlight: boolean;
}>): SessionRuntimeIssueV1 {
  const exitCode = params.exitCode === null ? '' : ` code ${params.exitCode}`;
  const signal = params.signal ? ` signal ${params.signal}` : '';
  const fallbackMessage = params.turnWasInFlight
    ? `Claude unified terminal process exited while a turn was in flight${exitCode}${signal}`
    : `Claude unified terminal process exited while the session was idle${exitCode}${signal}`;
  return buildClaudeIssue({
    code: 'claude.process_exited',
    source: 'agent_process_exit',
    occurredAt: params.occurredAt,
    agentId: 'claude',
  }, {
    message: fallbackMessage,
    exitCode: params.exitCode,
    signal: params.signal,
  }, fallbackMessage);
}
