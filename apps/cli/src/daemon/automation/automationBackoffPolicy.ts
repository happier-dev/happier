import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';

export type AutomationWorkerErrorClass = 'transient' | 'permanent';

const PERMANENT_RETRY_DELAY_MS = 300_000;

/**
 * The Automation worker owns cadence, not semantics. Every endpoint failure it
 * sees is classified by the one daemon server-work classifier, so an auth
 * failure, a generation conflict, a rate limit and a network fault mean the
 * same thing here as they do in every other daemon server call.
 *
 * `protocol_error` is the classifier's "nothing recognised this" result rather
 * than a positive statement that retrying is pointless. The claim loop is the
 * worker's only liveness path, so an unrecognised failure keeps the ordinary
 * backoff curve instead of dropping to the long permanent cadence.
 */
function isRetryableAutomationWorkerFailure(
  classification: ReturnType<typeof classifyDaemonServerWorkError>,
): boolean {
  return classification.retryable || classification.kind === 'protocol_error';
}

export function classifyAutomationWorkerError(error: unknown): AutomationWorkerErrorClass {
  return isRetryableAutomationWorkerFailure(classifyDaemonServerWorkError(error))
    ? 'transient'
    : 'permanent';
}

export function nextAutomationBackoffMs(failureCount: number): number {
  const normalized = Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0;
  const base = 500;
  const exp = Math.min(normalized, 8);
  return Math.min(base * (2 ** exp), 60_000);
}

export function nextAutomationRetryDelayMs(params: {
  failureCount: number;
  error: unknown;
}): number {
  const classification = classifyDaemonServerWorkError(params.error);
  if (!isRetryableAutomationWorkerFailure(classification)) {
    return PERMANENT_RETRY_DELAY_MS;
  }
  const backoff = nextAutomationBackoffMs(params.failureCount);
  if (classification.retryAfterMs === undefined) return backoff;
  // An authoritative server wait outranks the worker's own curve, but the
  // worker still never polls faster than its backoff and never idles longer
  // than the cadence it already uses for a hopeless endpoint.
  return Math.min(
    PERMANENT_RETRY_DELAY_MS,
    Math.max(backoff, classification.retryAfterMs),
  );
}
