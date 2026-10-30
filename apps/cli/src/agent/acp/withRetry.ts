import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { createBackoff } from '@/utils/time';
import { buildSafeProviderRejectionPreview } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';

export type AcpRequestOperation =
  | 'Initialize'
  | 'Authenticate'
  | 'NewSession'
  | 'StartSession'
  | 'LoadSession'
  | 'ForkSession';

export type AcpRequestFailureKind = 'transport' | 'timeout' | 'provider_rejection' | 'unknown';

export function classifyAcpRequestFailureForLog(error: unknown): AcpRequestFailureKind {
  // A peer rejection stays a rejection even when its message describes an MCP transport failure.
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'number') return 'provider_rejection';
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
  sanitizedPreview?: string;
  authenticationSetupFailure?: true;
}> {
  // Share the user-visible issue's sanitizer and bound; never serialize provider error data.
  const code = params.error && typeof params.error === 'object' && 'code' in params.error
    ? params.error.code
    : undefined;
  const sanitizedPreview = buildSafeProviderRejectionPreview(params.error);
  return Object.freeze({
    operation: params.operation,
    failureKind: classifyAcpRequestFailureForLog(params.error),
    ...(sanitizedPreview ? { sanitizedPreview } : {}),
    ...(params.error && typeof params.error === 'object'
      && 'authenticationSetupFailure' in params.error
      && params.error.authenticationSetupFailure === true ? { authenticationSetupFailure: true as const } : {}),
    ...(typeof code === 'number' && Number.isSafeInteger(code) ? { requestErrorCode: code } : {}),
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
    shouldRetry?: (error: unknown) => boolean;
  },
): Promise<T> {
  const backoff = createBackoff({
    minDelay: options.baseDelayMs,
    maxDelay: options.maxDelayMs,
    maxFailureCount: options.maxAttempts,
    shouldRetry: (error: unknown) => {
      if (options.shouldRetry?.(error) === false) return false;
      if (!error || typeof error !== 'object') return true;
      if ('retryable' in error && error.retryable === false) return false;
      if ('canTryAgain' in error && error.canTryAgain === false) return false;
      // JSON-RPC parse/invalid-request/method/params rejections cannot change on resend.
      return !('code' in error && [-32700, -32600, -32601, -32602].includes(Number(error.code)));
    },
    onError: (e: unknown, failuresCount: number) => {
      const error =
        e instanceof Error
          ? e
          : new Error(formatErrorForUi(e, { maxChars: 10_000 }), { cause: e });

      const attempt = failuresCount;
      logger.debug('[AcpBackend] Retrying ACP request after failure', {
        ...createAcpRequestFailureLogRecord({ operation: options.operationName, error }),
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
