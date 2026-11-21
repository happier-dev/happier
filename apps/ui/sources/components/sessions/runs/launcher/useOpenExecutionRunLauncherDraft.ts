import * as React from 'react';
import { useSessionAgentStartOpener } from '@/components/sessions/agents/launch/useSessionAgentStartOpener';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { prepareExecutionRunLauncherDraft, type ExecutionRunLauncherDraftSeed } from './prepareExecutionRunLauncherDraft';

/** Opens the shared Run authoring body in its Session pane or, for a global Review, its existing modal. */
export function useOpenExecutionRunLauncherDraft(): (seed: ExecutionRunLauncherDraftSeed) => Promise<void> {
    const openStart = useSessionAgentStartOpener();
    const instanceKey = useDestinationInstanceKey();
    return React.useCallback(async (seed: ExecutionRunLauncherDraftSeed) => {
        if (seed.sessionId === null) {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime || !areServerAccountScopesEqual(lifetime.scope, seed.scope)) return;
            const { presentReviewExecutionRunLaunchSelection } = await import('./reviewExecutionRunLaunchSelection');
            if (!lifetime.isCurrent()) return;
            const modal = presentReviewExecutionRunLaunchSelection({
                sessionId: null, serverId: seed.scope.serverId, draft: seed.input, isCurrent: lifetime.isCurrent,
            });
            const retirement = lifetime.onRetire(modal.close);
            void modal.result.finally(() => retirement.dispose());
            return;
        }
        const tab = prepareExecutionRunLauncherDraft(seed);
        openStart(createSessionPaneScopeId(seed.sessionId, seed.scope.serverId, instanceKey), tab);
    }, [instanceKey, openStart]);
}
