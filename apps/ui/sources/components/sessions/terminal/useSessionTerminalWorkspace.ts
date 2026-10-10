import * as React from 'react';
import { useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { SessionTerminalActionId, SessionTerminalWorkspaceV1 } from '@happier-dev/protocol';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getActiveSessionTerminal, readSessionTerminalWorkspace, type SessionTerminalWorkspaceCommand } from './sessionTerminalWorkspace';
import { resolveProjectTerminalScope } from '@/components/projects/detail/projectTerminalScope';

/** Process-affecting terminal verbs for one scope; needs no pane state, so embedded panes outside a pane host can use it. */
export function useSessionTerminalActionExecute(scopeId: string) {
    const actionExecute = React.useMemo(() => createFrontDoorActionExecute(), []);
    return React.useCallback((actionId: SessionTerminalActionId, input: Readonly<Record<string, unknown>> = {}) => {
        const session = parseSessionPaneScopeId(scopeId);
        const project = session ? null : resolveProjectTerminalScope(scopeId);
        return actionExecute(actionId, { ...input, scopeId }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            defaultSessionId: session?.sessionId, serverId: session?.address?.serverId ?? project?.workspace.serverId,
            ...(project ? { expectedAccountId: project.scope.accountId } : {}),
        });
    }, [actionExecute, scopeId]);
}

export function useSessionTerminalWorkspace(scopeId: string, initialWorkspace?: SessionTerminalWorkspaceV1) {
    const { state, dispatch } = useAppPaneContext();
    const raw = state.scopes[scopeId]?.bottom.tabState.terminal;
    const workspace = React.useMemo(() => readSessionTerminalWorkspace(raw ?? initialWorkspace), [raw, initialWorkspace]);
    const execute = useSessionTerminalActionExecute(scopeId);
    // Only the real SplitCanvasHost writes measured geometry. Process-affecting UI verbs use Actions above.
    const dispatchResize = React.useCallback((command: Extract<SessionTerminalWorkspaceCommand, { type: 'resize' }>) => dispatch({ type: 'terminalWorkspace', scopeId, command }), [dispatch, scopeId]);
    return React.useMemo(() => ({ workspace, activeTerminal: getActiveSessionTerminal(workspace), execute, dispatchResize }), [workspace, execute, dispatchResize]);
}
