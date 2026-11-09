import * as React from 'react';

import { useSessionMachineDisplayIdentity } from '@/components/sessions/model/useSessionMachineTarget';
import {
  useCheckoutReachability,
  type CheckoutReachability,
} from '@/components/workspaces/reachability/checkoutReachability';

/**
 * The Session's checkout reachability, from the shared checkout-reachability owner: a source-control
 * surface waiting on a snapshot that an unreachable Machine cannot deliver says so instead of loading.
 */
export function useSessionCheckoutReachability(
  sessionId: string,
  serverId: string | null | undefined,
): CheckoutReachability {
  const machineId = useSessionMachineDisplayIdentity(
    sessionId,
    serverId,
  ).machineId;
  const scope = React.useMemo(
    () => (serverId && machineId ? { serverId, machineId } : null),
    [serverId, machineId],
  );
  return useCheckoutReachability(scope);
}
