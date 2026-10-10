import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol';
import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { useSession } from '@/sync/domains/state/storage';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionMachineReachability } from '@/components/sessions/model/useSessionMachineReachability';
import { useSessionExecutionRunLaunchability } from '@/hooks/session/useSessionExecutionRunLaunchability';
import { useSessionExternalSessionRuntime } from '@/components/sessions/model/useSessionExternalSessionRuntime';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { useScmDiffSummaryBinding } from './useScmDiffSummaryBinding';

/** Session authority and launch policy feed the shared saved-result binding. */
export function useSessionScmDiffSummaryBinding(params: Readonly<{
    sessionId: string; serverId?: string | null; comparison: SessionScmReviewComparison | null; output: ScmDiffSummaryOutputKind;
}>) {
    const session = useSession(params.sessionId, params.serverId);
    const machine = useSessionMachineTarget(params.sessionId, params.serverId);
    const { machineReachable } = useSessionMachineReachability(params.sessionId, params.serverId);
    const launch = useSessionExecutionRunLaunchability(params.sessionId, session, params.serverId);
    const external = useSessionExternalSessionRuntime({ sessionId: params.sessionId,
        metadata: session ? readSessionOwnerMetadataView(session) : null, serverId: params.serverId });
    const canControl = machineReachable && (external.externalSessionLink === null || external.status?.runnerActive === true);
    const canSend = canControl && Boolean(session && deriveTranscriptInteractionFromSession(session).canSendMessages);
    return useScmDiffSummaryBinding({ ...params, host: { sessionId: params.sessionId }, machine, machineReachable, launch, canControl, canSend });
}
