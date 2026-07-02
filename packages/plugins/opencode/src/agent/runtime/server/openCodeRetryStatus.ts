import { asRecord, normalizeNonNegativeInteger, normalizeString } from './openCodeParsing.js';

export type OpenCodeRetryStatusError = Error & Readonly<{
  code: 'opencode_session_retry';
  type: 'opencode_session_retry';
  headers?: Readonly<Record<string, string>>;
  retryAfterMs?: number;
  nextRetryAtMs?: number;
  metadata?: Readonly<{ attempt: number }>;
}>;

function openCodeRetryStatusLooksLikeRateLimit(message: string): boolean {
  return /\brate\s+limit\b/iu.test(message);
}

function openCodeRetryStatusLooksLikeUsageLimit(message: string): boolean {
  return /\b(usage\s+limit|quota|limit\s+reached|insufficient\s+credits|billing)\b/iu.test(message);
}

export function buildOpenCodeRetryStatusError(status: unknown): OpenCodeRetryStatusError | null {
  const record = asRecord(status);
  if (!record || normalizeString(record.type) !== 'retry') return null;

  const message = normalizeString(record.message) || 'OpenCode session is waiting before retrying';
  const nextRetryAtMs = normalizeNonNegativeInteger(record.next);
  const attempt = normalizeNonNegativeInteger(record.attempt);
  const error = new Error(message) as OpenCodeRetryStatusError;
  error.name = openCodeRetryStatusLooksLikeRateLimit(message)
    ? 'GoUsageLimitError'
    : openCodeRetryStatusLooksLikeUsageLimit(message)
      ? 'FreeUsageLimitError'
      : 'OpenCodeRetryStatusError';
  Object.defineProperties(error, {
    code: { value: 'opencode_session_retry', enumerable: true },
    type: { value: 'opencode_session_retry', enumerable: true },
  });
  if (nextRetryAtMs !== null) {
    const retryAfterMs = Math.max(0, nextRetryAtMs - Date.now());
    Object.defineProperties(error, {
      nextRetryAtMs: { value: nextRetryAtMs, enumerable: true },
      retryAfterMs: { value: retryAfterMs, enumerable: true },
      headers: { value: Object.freeze({ 'retry-after-ms': String(retryAfterMs) }), enumerable: true },
    });
  }
  if (attempt !== null) {
    Object.defineProperty(error, 'metadata', {
      value: Object.freeze({ attempt }),
      enumerable: true,
    });
  }
  return error;
}

export function isOpenCodeUsageLimitRetryStatusError(error: OpenCodeRetryStatusError): boolean {
  return error.name === 'FreeUsageLimitError' || error.name === 'GoUsageLimitError';
}

export function formatOpenCodeRetryStatusMessage(error: OpenCodeRetryStatusError): string {
  const details = [error.message];
  const attempt = error.metadata?.attempt;
  if (attempt !== undefined) details.push(`Retry attempt: ${attempt}.`);
  if (error.retryAfterMs !== undefined) details.push(`Retry after: ${error.retryAfterMs}ms.`);
  return details.join('\n');
}
