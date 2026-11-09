import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';

export type AutomationWorkerErrorClass = 'transient' | 'permanent';

/**
 * The Automation worker owns cadence, not semantics. Every endpoint failure it
 * sees is classified by the one daemon server-work classifier, so an auth
 * failure, a generation conflict, a rate limit and a network fault mean the
 * same thing here as they do in every other daemon server call.
 *
 * `protocol_error` remains unknown coverage. Recovery uses an actual server
 * deadline or the daemon's existing reconnect, push and explicit catch-up.
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

export function nextAutomationRetryDelayMs(params: {
  error: unknown;
}): number | null {
  const classification = classifyDaemonServerWorkError(params.error);
  // Without an owning future deadline, retain unknown coverage and wait for
  // the existing push, reconnect or explicit catch-up recovery edge.
  return classification.retryable && classification.retryAfterMs !== undefined && classification.retryAfterMs > 0
    ? classification.retryAfterMs : null;
}
