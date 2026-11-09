import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useSessionMachineId } from '@/sync/domains/state/storage';
import { extractExecutionRunsBackendsFromMachineCapabilitiesState } from '@/sync/domains/executionRuns/extractExecutionRunsBackendsFromMachineCapabilities';
import type { ExecutionRunBackendCapabilityMap } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';

export function useExecutionRunsBackendsForSession(
  sessionId: string,
  serverId?: string | null,
  /** Inactive forms neither subscribe to Session identity nor read capabilities. */
  enabled = true,
): ExecutionRunBackendCapabilityMap {
  const normalizedSessionId = React.useMemo(
    () => (enabled ? normalizeSessionId(sessionId) : ''),
    [enabled, sessionId],
  );
  // V-2 (2026-08-11): the metadata fallback reads a PRIMITIVE machine id, not the session record.
  // This hook only ever needed "which machine", and `useSession(id)` is a `useShallow` over the whole
  // `Session`, whose unrelated field updates must not rerun capability consumers.
  // `useSessionMachineTarget` is already narrow: it shallow-compares the resolved `{ machineId,
  // basePath }`, so it only fires when the target itself moves.
  const machineTarget = useSessionMachineTarget(normalizedSessionId, serverId);
  const sessionMetadataMachineId = useSessionMachineId(normalizedSessionId);
  // A bare Session fallback is only safe at the legacy unqualified boundary.
  // With an exact Home, absence of its target must fail closed rather than
  // borrowing a same-id Session's Machine from another Home.
  const machineId = machineTarget?.machineId ?? (serverId ? null : sessionMetadataMachineId);

  return useExecutionRunsBackendsForMachine({ machineId, serverId: serverId ?? null, enabled });
}

/**
 * The execution-run backends one exact Machine reports — the capability read the
 * Session hook above makes for its Session's Machine. A surface that already
 * knows the Machine (a workflow's Where) reads it here instead of borrowing a
 * Session. `enabled: false` (or no Machine) issues no detect RPC.
 */
export function useExecutionRunsBackendsForMachine(params: Readonly<{
  machineId: string | null;
  serverId: string | null;
  enabled: boolean;
}>): ExecutionRunBackendCapabilityMap {
  const machineCapabilities = useMachineCapabilitiesCache({
    machineId: params.machineId,
    ...(params.serverId ? { serverId: params.serverId } : {}),
    enabled: params.enabled && Boolean(params.machineId),
    request: { requests: [{ id: 'tool.executionRuns' }] } as any,
  });

  return React.useMemo(() => extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilities.state), [machineCapabilities.state]);
}
