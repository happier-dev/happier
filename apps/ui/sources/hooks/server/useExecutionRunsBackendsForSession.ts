import * as React from 'react';

import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useSession } from '@/sync/domains/state/storage';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';

export function useExecutionRunsBackendsForSession(sessionId: string): Record<string, any> | null {
  const session = useSession(sessionId);
  const machineId =
    typeof (session as any)?.metadata?.machineId === 'string' ? String((session as any).metadata.machineId).trim() : null;

  const machineCapabilities = useMachineCapabilitiesCache({
    machineId,
    enabled: Boolean(machineId),
    request: { requests: [{ id: 'tool.executionRuns' }] } as any,
  });

  return React.useMemo(() => extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilities.state), [machineCapabilities.state]);
}

