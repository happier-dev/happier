import * as React from 'react';

import { useOptionalSessionViewerController } from '@/components/sessions/viewer/SessionViewerController';
import { useSessionViewerMachineId } from '@/components/sessions/viewer/useSessionViewerMachine';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { t } from '@/text';

/**
 * The one way to open a Session's shared window: the Session's viewer, through its mounted
 * presentation owner (the same front door as `session.presentation.apply` `viewer.open`). It floats
 * beside the reading column on desktop and docks at the top of the reading flow on a phone. Null
 * where no viewer owner is mounted or the request names another machine, so callers render no
 * Watch that cannot land. A retained offline Machine keeps its launcher with the presence owner's
 * reason; opening an already-presented viewer and its recovery state remain the viewer's authority.
 */
export function useOpenSessionComputerScreen(
  input: Readonly<{
    sessionId: string;
    serverId: string | null;
    /** The machine a request named; it must be the Session's own (otherwise there is nothing to open). */
    machineId?: string | null;
  }>,
): Readonly<{ open: () => void; disabledReason: string | null; machineName: string | null }> | null {
  const serverId = usePreferredServerIdForSession({
    sessionId: input.sessionId,
    serverId: input.serverId,
  });
  const viewer = useOptionalSessionViewerController();
  // Computer use targets the Session's own machine: a request naming another machine has no viewer.
  const sessionMachineId = useSessionViewerMachineId(input.sessionId, serverId);
  const machineId =
    sessionMachineId &&
    (!input.machineId || input.machineId === sessionMachineId)
      ? sessionMachineId
      : null;
  const request = viewer?.requestSemantic;
  const presence = useMachinePresenceSummary(serverId, request ? machineId : null);
  const disabledReason = presence.reachability === 'unreachable'
    ? t('projects.checkouts.notAnswering', { machine: presence.sentenceName ?? presence.name ?? t('machine.thisMachineInSentence') })
    : null;
  const open = React.useCallback(() => {
    if (disabledReason) return;
    void request?.({ kind: 'viewer.open', source: 'computer' });
  }, [disabledReason, request]);
  const machineName = presence.name ?? null;
  return React.useMemo(() => machineId && request ? { open, disabledReason, machineName } : null,
    [disabledReason, machineId, machineName, open, request]);
}
