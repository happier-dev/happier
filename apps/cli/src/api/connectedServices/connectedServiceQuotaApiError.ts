import axios from 'axios';

export type ConnectedServiceQuotaApiErrorKind = 'auth' | 'http' | 'protocol' | 'retryable';

export class ConnectedServiceQuotaApiError extends Error {
  readonly kind: ConnectedServiceQuotaApiErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly quotaFetchErrorCode?: 'auth_failure';
  readonly cause: unknown;

  constructor(params: Readonly<{
    message: string;
    kind: ConnectedServiceQuotaApiErrorKind;
    status?: number | null;
    retryable: boolean;
    retryAfterMs?: number | null;
    quotaFetchErrorCode?: 'auth_failure';
    cause?: unknown;
  }>) {
    super(params.message);
    this.name = 'ConnectedServiceQuotaApiError';
    this.kind = params.kind;
    this.status = params.status ?? null;
    this.retryable = params.retryable;
    this.retryAfterMs = params.retryAfterMs ?? null;
    this.cause = params.cause;
    if (params.quotaFetchErrorCode) this.quotaFetchErrorCode = params.quotaFetchErrorCode;
  }
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  const maybeGet = (headers as Readonly<{ get?: unknown }>).get;
  if (typeof maybeGet === 'function') {
    const value = maybeGet.call(headers, name);
    return typeof value === 'string' && value.trim() ? value : null;
  }
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lowerName) continue;
    return typeof value === 'string' && value.trim() ? value : null;
  }
  return null;
}

function parseNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

function readRetryAfterMs(headers: unknown, nowMs: number): number | null {
  const retryAfterMs = parseNonNegativeInteger(readHeader(headers, 'retry-after-ms'));
  if (retryAfterMs !== null) return retryAfterMs;
  const retryAfter = readHeader(headers, 'retry-after');
  const retryAfterSeconds = parseNonNegativeInteger(retryAfter);
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1000;
  if (!retryAfter) return null;
  const dateMs = Date.parse(retryAfter);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, Math.trunc(dateMs - nowMs));
}

function readAxiosStatus(error: unknown): number | null {
  if (!axios.isAxiosError(error)) return null;
  const status = error.response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? Math.trunc(status) : null;
}

function isRetryableStatus(status: number | null): boolean {
  return status === null || status === 429 || (status >= 500 && status < 600);
}

export function createConnectedServiceQuotaProtocolError(
  message: string,
  cause?: unknown,
): ConnectedServiceQuotaApiError {
  return new ConnectedServiceQuotaApiError({
    message,
    kind: 'protocol',
    status: null,
    retryable: false,
    cause,
  });
}

export function createConnectedServiceQuotaHttpStatusError(params: Readonly<{
  status: number;
  message: string;
}>): ConnectedServiceQuotaApiError {
  const kind = params.status === 401 || params.status === 403
    ? 'auth'
    : isRetryableStatus(params.status)
      ? 'retryable'
      : 'http';
  return new ConnectedServiceQuotaApiError({
    message: params.message,
    kind,
    status: params.status,
    retryable: kind === 'retryable',
    quotaFetchErrorCode: kind === 'auth' ? 'auth_failure' : undefined,
  });
}

export function createConnectedServiceQuotaApiError(params: Readonly<{
  message: string;
  cause: unknown;
  nowMs?: number;
}>): ConnectedServiceQuotaApiError {
  if (params.cause instanceof ConnectedServiceQuotaApiError) return params.cause;
  const status = readAxiosStatus(params.cause);
  const retryAfterMs = axios.isAxiosError(params.cause)
    ? readRetryAfterMs(params.cause.response?.headers, params.nowMs ?? Date.now())
    : null;
  const kind = status === 401 || status === 403
    ? 'auth'
    : isRetryableStatus(status)
      ? 'retryable'
      : 'http';
  return new ConnectedServiceQuotaApiError({
    message: params.message,
    kind,
    status,
    retryable: kind === 'retryable',
    retryAfterMs,
    quotaFetchErrorCode: kind === 'auth' ? 'auth_failure' : undefined,
    cause: params.cause,
  });
}
