import * as React from 'react';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import {
    createExecutionRunDetailsTab,
} from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** Conversations use canonical Details resources; their owner chooses responsive placement. */
export function useOpenSessionAgentConversation(input: Readonly<{
    address: SessionAddress;
}>): Readonly<{
    /** Opens a Run's conversation; `title` names its tab by intent when the caller knows it. */
    openAgentConversation: (runId: string, title?: string | null) => void;
}> {
    const pane = useAppPaneScope(useDestinationPaneScopeId(createSessionPaneScopeId(input.address.sessionId, input.address.serverId)));

    return React.useMemo(() => ({
        openAgentConversation: (runId: string, title?: string | null) => {
            pane.openDetailsTab(createExecutionRunDetailsTab(runId, undefined, title), { intent: 'preview' });
        },
    }), [pane]);
}
