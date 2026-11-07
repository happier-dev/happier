import type { ManagedConnectionReason, ReadinessProbeResult, TransportDisconnectEvent } from './managedConnectionTypes.js';

export function deriveManagedConnectionReason(params: Readonly<{
  disconnectEvent?: TransportDisconnectEvent;
  probe?: ReadinessProbeResult;
  initial?: boolean;
}>): ManagedConnectionReason {
  if (params.initial) return 'initial_connect';
  if (params.disconnectEvent?.intentional) return 'manual_disconnect';
  if (params.probe?.status === 'auth_failed') return 'auth_invalid';
  if (params.probe?.status === 'server_unreachable') return 'server_unreachable';
  if (params.probe?.status === 'retry_later') return params.probe.reason ?? 'probe_failed';
  return 'transport_disconnect';
}

/**
 * A supervisor's own retry timer re-enters `connecting` with a non-zero attempt; a start or an explicit
 * retry begins again at attempt zero. When the target is already presented as failed, the timer-driven
 * re-entry is not news: presenting it would cycle the UI through loading and error on every backoff tick.
 */
export function isRetryOfKnownFailure(
  state: Readonly<{ phase: string; attempt: number }>,
  failureIsPresented: boolean,
): boolean {
  return failureIsPresented && state.phase === 'connecting' && state.attempt > 0;
}
