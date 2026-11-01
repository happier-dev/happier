import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { createBackoff, isRetryableError } from '@/utils/time';

export type AcpRequestOperation =
  | 'Initialize'
  | 'Authenticate'
  | 'NewSession'
  | 'StartSession'
  | 'LoadSession'
  | 'ForkSession';

export type AcpRequestFailureKind = 'transport' | 'timeout' | 'provider_rejection' | 'unknown';

export function readAcpRequestErrorCode(error: unknown): number | null {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
}

export function classifyAcpRequestFailureForLog(error: unknown): AcpRequestFailureKind {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (
    normalized.includes('fetch failed')
    || normalized.includes('econnrefused')
    || normalized.includes('econnreset')
    || normalized.includes('socket hang up')
    || normalized.includes('connect_error')
    || normalized.includes('networkerror')
    || normalized.includes('other side closed')
  ) {
    return 'transport';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (error && typeof error === 'object' && 'code' in error) return 'provider_rejection';
  return 'unknown';
}

export function createAcpRequestFailureLogRecord(params: Readonly<{
  operation: AcpRequestOperation;
  error: unknown;
}>): Readonly<{
  operation: AcpRequestOperation;
  failureKind: AcpRequestFailureKind;
  requestErrorCode?: number;
  authenticationSetupFailure?: true;
}> {
  // JSON-RPC numeric codes are diagnostic metadata; provider messages/data may contain credentials.
  const code = readAcpRequestErrorCode(params.error);
  return Object.freeze({
    operation: params.operation,
    failureKind: classifyAcpRequestFailureForLog(params.error),
    ...(params.error && typeof params.error === 'object'
      && 'authenticationSetupFailure' in params.error
      && params.error.authenticationSetupFailure === true ? { authenticationSetupFailure: true as const } : {}),
    ...(code !== null ? { requestErrorCode: code } : {}),
  });
}

/**
 * Helper to run an async operation with retry logic.
 *
 * Delegates to the shared `createBackoff` utility while preserving
 * ACP-specific defaults: operation-name logging, non-Error wrapping,
 * and the `onRetry` callback.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    operationName: AcpRequestOperation;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  const backoff = createBackoff({
    minDelay: options.baseDelayMs,
    maxDelay: options.maxDelayMs,
    maxFailureCount: options.maxAttempts,
    shouldRetry: (error: unknown) => {
      const code = readAcpRequestErrorCode(error);
      // JSON-RPC parse / invalid request / missing method / invalid params cannot change
      // when the exact same initialize/authenticate request is sent again.
      return isRetryableError(error) && code !== -32700 && code !== -32600 && code !== -32601 && code !== -32602;
    },
    onError: (e: unknown, failuresCount: number) => {
      const error =
        e instanceof Error
          ? e
          : new Error(formatErrorForUi(e, { maxChars: 10_000 }), { cause: e });

      const attempt = failuresCount;
      logger.debug('[AcpBackend] Retrying ACP request after failure', {
        ...createAcpRequestFailureLogRecord({
          operation: options.operationName,
          error,
        }),
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts: options.maxAttempts,
      });
      options.onRetry?.(attempt, error);
    },
  });

  try {
    return await backoff(operation);
  } catch (rawError: unknown) {
    // Ensure the final thrown error is an Error instance, matching
    // the original withRetry contract that wraps non-Error values.
    if (rawError instanceof Error) {
      throw rawError;
    }
    throw new Error(formatErrorForUi(rawError, { maxChars: 10_000 }), { cause: rawError });
  }
}
