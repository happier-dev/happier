import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useSession } from '@/sync/domains/state/storage';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import type { ExecutionRunBackendCapabilityMap } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

export function useExecutionRunsBackendsForSession(
  sessionId: string,
  serverId?: string | null,
): ExecutionRunBackendCapabilityMap {
  const normalizedSessionId = React.useMemo(() => normalizeSessionId(sessionId), [sessionId]);
  const session = useSession(normalizedSessionId);
  const machineTarget = useSessionMachineTarget(normalizedSessionId);
  const machineId = machineTarget?.machineId ?? resolveSessionMachineId((session as any)?.metadata);

  const machineCapabilities = useMachineCapabilitiesCache({
    machineId,
    ...(serverId ? { serverId } : {}),
    enabled: Boolean(machineId),
    request: { requests: [{ id: 'tool.executionRuns' }] } as any,
  });

  return React.useMemo(() => extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilities.state), [machineCapabilities.state]);
}
