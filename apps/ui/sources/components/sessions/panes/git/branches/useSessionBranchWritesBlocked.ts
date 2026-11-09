import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
  useSessionProjectScmInFlightOperation,
  useSessionSelector,
} from '@/sync/store/hooks';

/**
 * Whether this Session's working copy can take a branch write right now, for every surface that offers the
 * branch list (the Git pane's header, the Companion's branch row). The list stays readable either way.
 * `sessionPaused`: the Session ended and its Machine can no longer be reached for it.
 */
export function useSessionBranchWritesBlocked(
  sessionId: string,
  serverId: string | null | undefined,
): Readonly<{
  blocked: boolean;
  sessionPaused: boolean;
}> {
  const writesEnabled = useFeatureEnabled(
    'scm.writeOperations',
    serverId ? { scopeKind: 'spawn', serverId } : undefined,
  );
  const operationInFlight =
    Boolean(useSessionProjectScmInFlightOperation(sessionId, serverId));
  const { machineRpcTargetAvailable } = useSessionMachineReachability(
    sessionId,
    serverId,
  );
  const sessionInactive = useSessionSelector(
    sessionId,
    serverId,
    (session) => session?.active === false,
  );
  const sessionPaused = sessionInactive && !machineRpcTargetAvailable;
  return {
    blocked: !writesEnabled || operationInFlight || sessionPaused,
    sessionPaused,
  };
}
