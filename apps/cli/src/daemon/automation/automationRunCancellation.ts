const AUTOMATION_RUN_CANCELLED_ABORT_REASON = Object.freeze({
  kind: 'automationRunCancelled',
} as const);

export function abortAutomationRunForAuthoritativeCancellation(controller: AbortController): void {
  if (!controller.signal.aborted) {
    controller.abort(AUTOMATION_RUN_CANCELLED_ABORT_REASON);
  }
}

export function isAuthoritativeAutomationRunCancellation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === AUTOMATION_RUN_CANCELLED_ABORT_REASON;
}
