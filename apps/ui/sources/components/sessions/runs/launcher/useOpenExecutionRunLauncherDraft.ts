import * as React from 'react';
import { useSessionAgentStartOpener } from '@/components/sessions/agents/launch/useSessionAgentStartOpener';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { prepareExecutionRunLauncherDraft, type ExecutionRunLauncherDraftSeed } from './prepareExecutionRunLauncherDraft';

/** Seeds the Session's existing Run draft, then delegates Start placement to the pane owner. */
export function useOpenExecutionRunLauncherDraft(): (seed: ExecutionRunLauncherDraftSeed) => void {
    const openStart = useSessionAgentStartOpener();
    const instanceKey = useDestinationInstanceKey();
    return React.useCallback((seed: ExecutionRunLauncherDraftSeed) => {
        const tab = prepareExecutionRunLauncherDraft(seed);
        openStart(createSessionPaneScopeId(seed.sessionId, seed.scope.serverId, instanceKey), tab);
    }, [instanceKey, openStart]);
}
