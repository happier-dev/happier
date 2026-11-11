import { setTimeout as delay } from 'node:timers/promises';

import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';

export type HomeOperationRetry = Readonly<{
  deadlineMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}>;

// Existing guest polling cadences, shared by controller enrollment observations.
export const REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS = 500;
export const TERMINAL_AUTH_POLL_INTERVAL_MS = 1000;

export function isRetryableHomeOperationError(error: unknown): boolean {
  const failure = classifyServerEndpointError(error);
  return failure.retryable && failure.kind !== 'generation_conflict';
}

/** Only repeatable Home work belongs here; never replay a one-shot claim or native effect. */
export async function retryHomeOperation<T>(
  lifetime: HomeOperationRetry | Readonly<{ deadlineMs?: never; signal: AbortSignal; pollIntervalMs: number }>,
  operation: () => Promise<T>,
): Promise<T> {
  while (true) {
    lifetime.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      lifetime.signal?.throwIfAborted();
      const failure = classifyServerEndpointError(error);
      // A retired admission (409) is authoritative, not transient Home unavailability.
      if (!isRetryableHomeOperationError(error)) throw error;
      const remainingMs = lifetime.deadlineMs === undefined ? undefined : lifetime.deadlineMs - Date.now();
      if (remainingMs !== undefined && remainingMs <= 0) throw error;
      const retryDelayMs = failure.retryAfterMs ?? lifetime.pollIntervalMs;
      await delay(remainingMs === undefined ? retryDelayMs : Math.min(retryDelayMs, remainingMs), undefined,
        { signal: lifetime.signal });
      lifetime.signal?.throwIfAborted();
      // Preserve the last Home failure when its existing lifetime runs out.
      if (lifetime.deadlineMs !== undefined && Date.now() >= lifetime.deadlineMs) throw error;
    }
  }
}
