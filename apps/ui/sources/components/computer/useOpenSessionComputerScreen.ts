import * as React from 'react';

import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

/**
 * The one way to open a Session's shared window: the Session's viewer, through its mounted
 * presentation owner (the same front door as `session.presentation.apply` `viewer.open`). It floats
 * beside the reading column on desktop and docks at the top of the reading flow on a phone. Null
 * where no viewer owner is mounted or the request names another machine, so callers render no
 * Watch that cannot land.
 */
export function useOpenSessionComputerScreen(
  input: Readonly<{
    sessionId: string;
    serverId: string | null;
    /** The machine a request named; it must be the Session's own (otherwise there is nothing to open). */
    machineId?: string | null;
  }>,
): (() => void) | null {
  const serverId = usePreferredServerIdForSession({
    sessionId: input.sessionId,
    serverId: input.serverId,
  });
  const viewer = useOptionalSessionViewerController();
  // Computer use targets the Session's own machine: a request naming another machine has no viewer.
  const sessionMachineId =
    useSessionMachineTarget(input.sessionId, serverId)?.machineId ?? null;
  const machineId =
    sessionMachineId &&
    (!input.machineId || input.machineId === sessionMachineId)
      ? sessionMachineId
      : null;
  const request = viewer?.requestSemantic;
  const open = React.useCallback(() => {
    void request?.({ kind: 'viewer.open', source: 'computer' });
  }, [request]);
  if (!machineId || !request) return null;
  return open;
}
