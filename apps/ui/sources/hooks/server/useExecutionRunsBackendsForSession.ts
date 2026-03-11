import * as React from 'react';

import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { resolveSessionMachineId } from '@/sync/domains/session/directSessions/resolveSessionMachineId';
import { useSession } from '@/sync/domains/state/storage';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';

export function useExecutionRunsBackendsForSession(sessionId: string): Record<string, any> | null {
  const session = useSession(sessionId);
  const machineId = React.useMemo(() => resolveSessionMachineId((session as any)?.metadata), [(session as any)?.metadata]);

  const machineCapabilities = useMachineCapabilitiesCache({
    machineId,
    enabled: Boolean(machineId),
    request: { requests: [{ id: 'tool.executionRuns' }] } as any,
  });

  return React.useMemo(() => extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilities.state), [machineCapabilities.state]);
}
