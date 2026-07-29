import { classifyServerEndpointError } from './classifyServerEndpointError';
import { serializeAxiosErrorForLog } from './serializeAxiosErrorForLog';

const DEFAULT_TRANSIENT_LOG_INTERVAL_MS = 60_000;

type LoggerLike = Readonly<{
  debug?: (message: string, ...args: readonly unknown[]) => void;
}>;

const transientLogByKey = new Map<string, number>();

function formatTransientMessage(operation: string): string {
  return `[API] ${operation} temporarily unavailable; will retry or recover when the server is ready.`;
}

function formatErrorMessage(operation: string): string {
  return `[API] [ERROR] ${operation}:`;
}

function resolveSampleKey(
  operation: string,
  classification: ReturnType<typeof classifyServerEndpointError>,
): string {
  return [
    operation,
    classification.kind,
    classification.statusCode ?? '',
  ].join('\0');
}

export function resetServerEndpointFailureLogSamplingForTests(): void {
  transientLogByKey.clear();
}

export function logServerEndpointFailure({
  logger,
  operation,
  error,
  nowMs = Date.now(),
  transientLogIntervalMs = DEFAULT_TRANSIENT_LOG_INTERVAL_MS,
}: Readonly<{
  logger: LoggerLike;
  operation: string;
  error: unknown;
  nowMs?: number;
  transientLogIntervalMs?: number;
}>): Readonly<{
  logged: boolean;
  classification: ReturnType<typeof classifyServerEndpointError>;
}> {
  const classification = classifyServerEndpointError(error);
  const payload = {
    classification,
    error: serializeAxiosErrorForLog(error),
  };

  if (!classification.retryable) {
    logger.debug?.(formatErrorMessage(operation), payload);
    return { logged: true, classification };
  }

  const key = resolveSampleKey(operation, classification);
  const lastLoggedAt = transientLogByKey.get(key);
  if (
    typeof lastLoggedAt === 'number' &&
    nowMs - lastLoggedAt < Math.max(0, transientLogIntervalMs)
  ) {
    return { logged: false, classification };
  }

  transientLogByKey.set(key, nowMs);
  logger.debug?.(formatTransientMessage(operation), payload);
  return { logged: true, classification };
}
