import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionSubagentDetailsTab } from '@/components/sessions/agents/navigation/createSessionSubagentDetailsTab';
import { resolveSessionSubagentAdvancedRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentAdvancedRoute';
import { resolveSessionSubagentFullRoute } from '@/components/sessions/agents/navigation/resolveSessionSubagentFullRoute';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { useDeviceType } from '@/utils/platform/responsive';
import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';

import { createSessionPeekDetailsTab } from './createSessionPeekDetailsTab';
import { resolveWorkItemContextActions, resolveWorkItemOpenTarget, type WorkItem } from './workProjection';

/**
 * Where each Work item opens — one owner for the Work list, the Work map and the ⤢ map, so the three
 * cannot send the same item to different places.
 *
 * Beside the lead a Session opens its peek (a Details tab) and a background run its Run details; a
 * phone, where a Details tab would open out of sight, pushes the Session or the Run instead. A workflow
 * run opens FIN's run page, or the Inbox while it waits for the person (`resolveWorkItemOpenTarget`):
 * no row or node answers anything itself.
 */
export function useSessionWorkOpeners(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    subagents: readonly SessionSubagent[];
}>) {
    const router = useRouter();
    const deviceType = useDeviceType();
    const pane = useAppPaneScope(params.scopeId);
    const inboxAvailable = useInboxAvailable();
    const { sessionId, serverId, subagents } = params;

    const openSubagentFull = React.useCallback((subagent: SessionSubagent) => {
        const route = resolveSessionSubagentFullRoute({ sessionId, serverId, subagent });
        if (route) router.push(route as never);
    }, [router, serverId, sessionId]);
    const openSubagentPreview = React.useCallback((subagent: SessionSubagent) => {
        if (deviceType === 'phone' || !subagent.capabilities.canOpen) {
            openSubagentFull(subagent);
            return;
        }
        pane.openDetailsTab(createSessionSubagentDetailsTab(subagent), { intent: 'preview' });
    }, [deviceType, openSubagentFull, pane]);
    const openSubagentAdvanced = React.useCallback((subagent: SessionSubagent) => {
        const route = resolveSessionSubagentAdvancedRoute({ sessionId, serverId, subagent });
        if (route) router.push(route as never);
    }, [router, serverId, sessionId]);

    const openItem = React.useCallback((item: WorkItem) => {
        const target = resolveWorkItemOpenTarget(item, { inboxAvailable });
        switch (target.kind) {
            case 'inbox':
                router.push('/inbox' as never);
                return;
            case 'session': {
                const peekSessionId = target.sessionId;
                if (deviceType === 'phone') {
                    router.push(buildScopedSessionRouteHref({ sessionId: peekSessionId, serverId }) as never);
                    return;
                }
                // The peek's own header says who the Session reports to; the tab names the Session.
                pane.openDetailsTab(createSessionPeekDetailsTab({
                    sessionId: peekSessionId,
                    title: item.title,
                }), { intent: 'preview' });
                return;
            }
            case 'workflow_run':
                router.push(createWorkflowRunRoute(target.runId, serverId) as never);
                return;
            case 'action_operation':
                openActionOperationDetail(target);
                return;
            case 'agent_activity': {
                const subagentId = target.subagentId;
                const subagent = subagentId ? subagents.find((candidate) => candidate.id === subagentId) ?? null : null;
                if (subagent) openSubagentPreview(subagent);
                return;
            }
        }
    }, [deviceType, inboxAvailable, openSubagentPreview, pane, router, serverId, subagents]);

    const showItemInTranscript = React.useCallback((item: WorkItem) => {
        const origin = resolveWorkItemContextActions(item).transcript;
        if (origin) router.push(buildScopedSessionRouteHref(origin) as never);
    }, [router]);
    return { openItem, showItemInTranscript, openSubagentPreview, openSubagentFull, openSubagentAdvanced };
}
