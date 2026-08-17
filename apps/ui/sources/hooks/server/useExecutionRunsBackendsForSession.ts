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
  /**
   * F-4 (2026-08-11): `enabled: false` makes this hook inert — the session selectors below read the
   * empty id, so there is no session identity to re-render on and no capabilities detect RPC. It
   * exists because the transcript now needs this snapshot (it
   * decides how many `HappierSelect` rows an `action-draft` card paints, see
   * `sessionActionFieldOptions.ts`) and a transcript with no draft row must not pay for it. Mirrors
   * the flag `usePreferredServerIdForSession` already takes, and defaults to the previous behaviour.
   */
  enabled = true,
): ExecutionRunBackendCapabilityMap {
  const normalizedSessionId = React.useMemo(
    () => (enabled ? normalizeSessionId(sessionId) : ''),
    [enabled, sessionId],
  );
  // V-2 (2026-08-11): the metadata fallback reads a PRIMITIVE machine id, not the session record.
  // This hook only ever needed "which machine", and `useSession(id)` is a `useShallow` over the whole
  // `Session` — so with the transcript now calling this for every `action-draft` row, an unrelated
  // session-field write re-ran the option resolver (MEASURED: 1 render per write, 0 after this).
  // `useSessionMachineTarget` is already narrow: it shallow-compares the resolved `{ machineId,
  // basePath }`, so it only fires when the target itself moves.
  const machineTarget = useSessionMachineTarget(normalizedSessionId);
  const sessionMetadataMachineId = useSessionMachineId(normalizedSessionId);
  const machineId = machineTarget?.machineId ?? sessionMetadataMachineId;

  const machineCapabilities = useMachineCapabilitiesCache({
    machineId,
    ...(serverId ? { serverId } : {}),
    enabled: enabled && Boolean(machineId),
    request: { requests: [{ id: 'tool.executionRuns' }] } as any,
  });

  return React.useMemo(() => extractExecutionRunsBackendsFromMachineCapabilitiesState(machineCapabilities.state), [machineCapabilities.state]);
}
