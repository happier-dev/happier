import type {
  SessionRuntimeIssueSourceV1,
  SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

export type PrimarySessionRuntimeIssueCause =
  | 'status_error'
  | 'process_exit'
  | 'session_error'
  | 'usage_limit'
  | 'auth_error'
  | 'stream_error'
  | 'permission_blocked'
  | 'unknown';

export type ClassifyPrimarySessionRuntimeIssueInput = Readonly<{
  provider?: string | null;
  providerTurnId?: string | null;
  sessionSeq?: number | null;
  cause?: PrimarySessionRuntimeIssueCause | null;
  error?: unknown;
  occurredAt?: number | null;
}>;

const causeSourceMap = {
  status_error: 'provider_status_error',
  process_exit: 'provider_process_exit',
  session_error: 'provider_session_error',
  usage_limit: 'usage_limit',
  auth_error: 'auth_error',
  stream_error: 'stream_error',
  permission_blocked: 'permission_blocked',
  unknown: 'unknown',
} as const satisfies Record<PrimarySessionRuntimeIssueCause, SessionRuntimeIssueSourceV1>;

const sanitizedPreviewBySource = {
  provider_status_error: 'Provider reported an error',
  provider_process_exit: 'Provider process exited',
  provider_session_error: 'Provider session failed',
  usage_limit: 'Usage limit reached',
  auth_error: 'Authentication failed',
  stream_error: 'Provider stream failed',
  permission_blocked: 'Permission blocked',
  unknown: 'Session runtime failed',
} as const satisfies Record<SessionRuntimeIssueSourceV1, string>;

function extractErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (!error || typeof error !== 'object') return '';
  const record = error as Record<string, unknown>;
  return [record.message, record.detail, record.error, record.code, record.status]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

function refineStatusErrorSource(input: ClassifyPrimarySessionRuntimeIssueInput): SessionRuntimeIssueSourceV1 {
  const text = extractErrorText(input.error).toLowerCase();
  if (/\b(unauthorized|unauthenticated|authentication|auth|login required|not logged in|api key|401|403)\b/u.test(text)) {
    return 'auth_error';
  }
  if (/\b(quota|usage limit|rate limit|limit reached|max turns|insufficient credits|billing)\b/u.test(text)) {
    return 'usage_limit';
  }
  if (/\b(permission denied|permission blocked|blocked by policy|not allowed|access denied)\b/u.test(text)) {
    return 'permission_blocked';
  }
  return 'provider_status_error';
}

function normalizeNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
}

export function classifyPrimarySessionRuntimeIssue(
  input: ClassifyPrimarySessionRuntimeIssueInput,
): SessionRuntimeIssueV1 {
  const source = input.cause === 'status_error'
    ? refineStatusErrorSource(input)
    : causeSourceMap[input.cause ?? 'unknown'] ?? 'unknown';
  const occurredAt = normalizeNonNegativeInteger(input.occurredAt) ?? Date.now();
  const provider = normalizeNonEmptyString(input.provider);
  const providerTurnId = normalizeNonEmptyString(input.providerTurnId);
  const sessionSeq = normalizeNonNegativeInteger(input.sessionSeq);

  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: source,
    source,
    occurredAt,
    ...(sessionSeq === null ? {} : { sessionSeq }),
    ...(provider === null ? {} : { provider }),
    ...(providerTurnId === null ? {} : { providerTurnId }),
    sanitizedPreview: sanitizedPreviewBySource[source],
  };
}
