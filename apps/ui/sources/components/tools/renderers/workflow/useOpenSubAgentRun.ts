import * as React from 'react';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { useOptionalPinnedDetailsTabCommand } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/destinationInstanceContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createExecutionRunDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { buildSessionExecutionRunRouteHref } from '@/components/sessions/agents/navigation/buildSessionExecutionRunRouteHref';
import { readExecutionRunIdFromToolPayload } from '@/sync/domains/session/participants/deriveExecutionRunPollingRefreshKey';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';

/** A marker already carries its accepted Run: no Run lookup or row-local pane subscription is needed. */
export function useOpenSubAgentRun(input: Readonly<{
    tool: ToolCall;
    sessionId?: string;
    serverId?: string;
    navigate: ((href: string) => void) | null;
}>): (() => void) | null {
    const instanceKey = useDestinationInstanceKey();
    const openDetails = useOptionalPinnedDetailsTabCommand(createSessionPaneScopeId(input.sessionId ?? '', input.serverId, instanceKey));
    const runId = input.tool.name === 'SubAgentRun' ? readExecutionRunIdFromToolPayload(input.tool) : null;
    const { sessionId, serverId, navigate } = input;
    const open = React.useCallback(() => {
        if (!runId || !sessionId || !navigate) return;
        navigateWithBlurOnWeb(() => {
            if (openDetails(createExecutionRunDetailsTab(runId))) return;
            const href = buildSessionExecutionRunRouteHref({ sessionId, serverId, runId });
            if (href) navigate(href);
        });
    }, [navigate, openDetails, runId, serverId, sessionId]);
    return runId && sessionId && navigate ? open : null;
}
