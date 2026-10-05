import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

/**
 * Retired: there is no separate Automation create surface (FIN 03 §8.2, 04 §3.2). A trigger is added
 * where it lives — a session's Triggers section, or a workflow's Runs automatically section — and is
 * written through `session.trigger.*` / `workflow.trigger.*`. Old links land there:
 * - an exact-turn link opens that session's Triggers section;
 * - a New Session handoff opens its composed prompt in the workflow editor;
 * - anything else opens the Workflows destination.
 */
export function RetiredAutomationCreateRoute(): React.ReactElement {
    const params = useLocalSearchParams<{ sourceSessionId?: string; sourceTurnId?: string; sourceServerId?: string;
        sessionLifecycleEvents?: string; newSessionDraftSeedId?: string }>();
    if (typeof params.sourceSessionId === 'string' && params.sourceSessionId.length > 0) {
        return <Redirect href={{
            pathname: '/session/[id]/triggers',
            params: {
                id: params.sourceSessionId,
                sourceSessionId: params.sourceSessionId,
                ...(typeof params.sourceTurnId === 'string' ? { sourceTurnId: params.sourceTurnId } : {}),
                ...(typeof params.sourceServerId === 'string' ? { sourceServerId: params.sourceServerId } : {}),
                ...(typeof params.sessionLifecycleEvents === 'string' ? { sessionLifecycleEvents: params.sessionLifecycleEvents } : {}),
                ...(typeof params.sourceServerId === 'string' && params.sourceServerId.length > 0 ? { serverId: params.sourceServerId } : {}),
            },
        } as never} />;
    }
    if (typeof params.newSessionDraftSeedId === 'string' && params.newSessionDraftSeedId.length > 0) {
        return <Redirect href={{ pathname: '/workflows/new', params: { newSessionDraftSeedId: params.newSessionDraftSeedId } } as never} />;
    }
    return <Redirect href="/workflows" />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { RetiredAutomationCreateRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={RetiredAutomationCreateRoute} />; }
