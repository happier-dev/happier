import type { ReadinessProbeResult } from './managedConnectionTypes.js';

/** Project a transport refusal without retaining request/response objects or causes. */
export function readinessProbeFailure(error: unknown): Extract<ReadinessProbeResult, { status: 'server_unreachable' }> {
  const failure = error && typeof error === 'object'
    && 'retryable' in error && error.retryable === false
    && 'code' in error && typeof error.code === 'string'
    ? {
        code: error.code,
        retryable: false as const,
        ...('status' in error && typeof error.status === 'number' ? { status: error.status } : {}),
      }
    : undefined;
  return {
    status: 'server_unreachable',
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(failure ? { failure } : {}),
  };
}
