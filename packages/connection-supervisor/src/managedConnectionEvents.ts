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
  if (params.probe?.status === 'retry_later') return 'probe_failed';
  return 'transport_disconnect';
}
