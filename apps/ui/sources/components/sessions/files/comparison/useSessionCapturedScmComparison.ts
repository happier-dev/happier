import type { ScmComparison } from '@happier-dev/protocol';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSessionMachineDisplayIdentity, useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useCapturedScmComparison } from './useCapturedScmComparison';

export function useSessionCapturedScmComparison(params: Readonly<{
    sessionId: string; serverId?: string | null; comparison: SessionScmReviewComparison;
    active?: boolean; knownComparison?: ScmComparison | null;
}>) {
    const machine = useSessionMachineTarget(params.sessionId, params.serverId);
    const identity = useSessionMachineDisplayIdentity(params.sessionId, params.serverId);
    return useCapturedScmComparison({ ...params, host: { sessionId: params.sessionId }, machine, identity });
}
