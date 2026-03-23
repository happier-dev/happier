import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { createBackoff } from '@/utils/time';

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
    operationName: string;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  let failuresSoFar = 0;

  const backoff = createBackoff({
    minDelay: options.baseDelayMs,
    maxDelay: options.maxDelayMs,
    maxFailureCount: options.maxAttempts,
    // Always retry — withRetry has no retryable/canTryAgain gating.
    shouldRetry: () => true,
    onError: (e: unknown, failuresCount: number) => {
      failuresSoFar = failuresCount;
      const error =
        e instanceof Error
          ? e
          : new Error(formatErrorForUi(e, { maxChars: 10_000 }), { cause: e });

      const attempt = failuresCount;
      logger.debug(
        `[AcpBackend] ${options.operationName} failed (attempt ${attempt}/${options.maxAttempts}): ${error.message}. Retrying...`,
      );
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
