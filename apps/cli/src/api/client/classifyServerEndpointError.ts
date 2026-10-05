import { readHttpStatus } from './httpStatusError';

export type ServerEndpointErrorKind =
  | 'auth_failed'
  | 'unsupported'
  | 'generation_conflict'
  | 'rate_limited'
  | 'server_error'
  | 'dependency_unavailable'
  | 'timeout'
  | 'network'
  | 'client_error'
  | 'protocol_error';

export type ServerEndpointErrorClassification = Readonly<{
  kind: ServerEndpointErrorKind;
  retryable: boolean;
  statusCode?: number;
  retryAfterMs?: number;
}>;

export const NETWORK_ERROR_CODES = [
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'ERR_NETWORK',
  'ETIMEDOUT',
] as const;

const networkErrorCodeSet: ReadonlySet<string> = new Set(NETWORK_ERROR_CODES);
const preDispatchConnectionErrorCodes: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTDOWN', 'EHOSTUNREACH',
  'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND',
]);

export function isNetworkConnectionErrorCode(code: string | null | undefined): boolean {
  return code != null && networkErrorCodeSet.has(code.trim().toUpperCase());
}

export function isProvenPreDispatchConnectionFailure(error: unknown): boolean {
  const code = readNormalizedConnectionErrorCode(error);
  return code !== null && preDispatchConnectionErrorCodes.has(code);
}

/** A lost acknowledgement cannot establish whether a dispatched mutation committed. */
export function classifyActionTransportFailure(error: unknown, input: Readonly<{
  mutation: boolean;
  requestIssued: boolean;
  cancelled: boolean;
}>): 'cancelled' | 'outcome_unknown' | 'timeout' | 'network' | null {
  if (input.cancelled) return input.mutation && input.requestIssued ? 'outcome_unknown' : 'cancelled';
  const { kind } = classifyServerEndpointError(error);
  if (kind !== 'network' && kind !== 'timeout') return null;
  return input.mutation && input.requestIssued && !isProvenPreDispatchConnectionFailure(error)
    ? 'outcome_unknown' : kind;
}

export function readNormalizedConnectionErrorCode(error: unknown): string | null {
  const code = readErrorCode(error).trim().toUpperCase();
  return code.length > 0 ? code : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readHeader(headers: unknown, name: string): string | null {
  const record = asRecord(headers);
  if (!record) return null;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== lowerName) continue;
    if (Array.isArray(value)) {
      return value.find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)?.trim() ?? null;
    }
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readRetryAfterMs(error: unknown): number | undefined {
  const record = asRecord(error);
  if (typeof record?.retryAfterMs === 'number' && Number.isFinite(record.retryAfterMs)) {
    return Math.max(0, Math.trunc(record.retryAfterMs));
  }
  const response = asRecord(record?.response);
  const retryAfterMs = Number.parseFloat(readHeader(response?.headers, 'retry-after-ms') ?? '');
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return Math.floor(retryAfterMs);
  const retryAfter = readHeader(response?.headers, 'retry-after');
  const seconds = Number.parseFloat(retryAfter ?? '');
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  if (!retryAfter) return undefined;
  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function readErrorCode(error: unknown, depth = 0): string {
  const record = asRecord(error);
  const code = record?.code;
  if (typeof code === 'string' && code.trim().length > 0) return code;
  if (depth >= 4) return '';
  return readErrorCode(record?.cause, depth + 1);
}

function readErrorMessage(error: unknown, depth = 0): string {
  if (typeof error === 'string') return error;
  const record = asRecord(error);
  const message = record?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (depth >= 4) return '';
  return readErrorMessage(record?.cause, depth + 1);
}

function readRetryableHint(error: unknown): boolean {
  const record = asRecord(error);
  return record?.retryable === true;
}

function isTimeoutMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /\btimeout\b/.test(normalized) ||
    normalized.includes('timed out') ||
    normalized.includes('database failed to respond')
  );
}

function isNetworkMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnaborted') ||
    normalized.includes('enetdown') ||
    normalized.includes('enetunreach') ||
    normalized.includes('ehostdown') ||
    normalized.includes('ehostunreach') ||
    normalized.includes('enotfound') ||
    normalized.includes('eai_again') ||
    normalized.includes('socket hang up') ||
    normalized.includes('getaddrinfo') ||
    normalized.includes('network error') ||
    normalized.includes('connect econn')
  );
}

function readPreservedStatus(error: unknown): number | null {
  const status = readHttpStatus(error);
  if (status !== null) return status;
  const topLevelStatus = asRecord(error)?.status;
  return typeof topLevelStatus === 'number' && Number.isFinite(topLevelStatus)
    ? Math.trunc(topLevelStatus)
    : null;
}

export function classifyServerEndpointError(
  error: unknown,
  options: Readonly<{ featureAbsentStatusCodes?: readonly number[] }> = {},
): ServerEndpointErrorClassification {
  const statusCode = readPreservedStatus(error) ?? undefined;
  if (statusCode === 401 || statusCode === 403) {
    return { kind: 'auth_failed', retryable: false, statusCode };
  }

  if (typeof statusCode === 'number') {
    if (options.featureAbsentStatusCodes?.includes(statusCode)) {
      return { kind: 'unsupported', retryable: false, statusCode };
    }
    if (statusCode === 409) {
      return { kind: 'generation_conflict', retryable: true, statusCode };
    }
    if (statusCode === 429) {
      return {
        kind: 'rate_limited',
        retryable: true,
        statusCode,
        retryAfterMs: readRetryAfterMs(error),
      };
    }
    if (statusCode === 408 || statusCode === 425 || statusCode >= 500) {
      return {
        kind: 'server_error',
        retryable: true,
        statusCode,
        retryAfterMs: readRetryAfterMs(error),
      };
    }
    if (statusCode >= 400) {
      return { kind: 'client_error', retryable: false, statusCode };
    }
  }

  const code = readErrorCode(error);
  if (
    code === 'HAPPIER_ACCOUNT_MODE_UNKNOWN'
    || code === 'state_sharing_lock_unavailable'
  ) {
    return {
      kind: 'dependency_unavailable',
      retryable: true,
      retryAfterMs: readRetryAfterMs(error),
    };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') {
    return { kind: 'timeout', retryable: true, retryAfterMs: readRetryAfterMs(error) };
  }
  if (isNetworkConnectionErrorCode(code)) {
    return { kind: 'network', retryable: true, retryAfterMs: readRetryAfterMs(error) };
  }
  const message = readErrorMessage(error);
  if (isTimeoutMessage(message)) {
    return { kind: 'timeout', retryable: true, retryAfterMs: readRetryAfterMs(error) };
  }
  if (isNetworkMessage(message)) {
    return { kind: 'network', retryable: true, retryAfterMs: readRetryAfterMs(error) };
  }
  if (readRetryableHint(error)) {
    return { kind: 'network', retryable: true, retryAfterMs: readRetryAfterMs(error) };
  }

  return { kind: 'protocol_error', retryable: false };
}
