import type { PaneDetailsState, PaneScopeState } from './appPaneReducer';
import type { SelectedPaneDestinationV1 } from './selectedPaneDestination';
import { applyCloseDetailsTab } from '../details/workspace/detailsWorkspaceReducer';
import { isSessionTerminalWorkspacePane, readSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { resolveTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';

function closeTerminalPane(pane: PaneScopeState['right']): PaneScopeState['right'] {
    return isSessionTerminalWorkspacePane(pane)
        ? { ...pane, isOpen: false } : pane;
}

export function closeTerminalDetailsTabs(details: PaneDetailsState, terminalIds: ReadonlySet<string>): PaneDetailsState {
    let next = details;
    for (const tab of Object.values(details.tabsByKey)) {
        const instanceId = resolveTerminalDetailsInstanceId({ resource: tab.resource, tabKey: tab.key });
        if (instanceId && terminalIds.has(instanceId)) next = applyCloseDetailsTab(next, tab.key);
    }
    return next;
}

/** A pane reveal moves the workspace view; the retained Shells and split layout stay with the workspace. */
export function moveTerminalWorkspaceToPane(
    scope: PaneScopeState,
    destination: SelectedPaneDestinationV1 | null,
    pane: 'right' | 'bottom',
): PaneScopeState {
    if (destination?.kind !== 'builtin' || destination.id !== 'terminal') return scope;
    const otherPane = pane === 'right' ? 'bottom' : 'right';
    const other = scope[otherPane];
    const closedOther = closeTerminalPane(other);
    const workspace = readSessionTerminalWorkspace(scope.bottom.tabState.terminal);
    const activeTab = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
    const details = activeTab
        ? closeTerminalDetailsTabs(scope.details, new Set(activeTab.terminals.map(member => member.id)))
        : scope.details;
    if (closedOther === other && details === scope.details) return scope;
    return { ...scope, details, [otherPane]: closedOther };
}

export function moveTerminalMemberToDetails(scope: PaneScopeState, terminalId: string): PaneScopeState {
    const workspace = readSessionTerminalWorkspace(scope.bottom.tabState.terminal);
    const activeTab = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
    if (!activeTab?.terminals.some(member => member.id === terminalId)) return scope;
    const right = closeTerminalPane(scope.right);
    const bottom = closeTerminalPane(scope.bottom);
    return right === scope.right && bottom === scope.bottom ? scope : { ...scope, right, bottom };
}

/** Entering the Terminal route takes its workspace view once; later explicit moves remain authoritative. */
export function moveTerminalWorkspaceToPage(scope: PaneScopeState): PaneScopeState {
    const workspace = readSessionTerminalWorkspace(scope.bottom.tabState.terminal);
    const activeTab = workspace.tabs.find(tab => tab.id === workspace.activeTabId);
    const details = activeTab ? closeTerminalDetailsTabs(scope.details, new Set(activeTab.terminals.map(member => member.id))) : scope.details;
    const right = closeTerminalPane(scope.right);
    const bottom = closeTerminalPane(scope.bottom);
    return right === scope.right && bottom === scope.bottom && details === scope.details ? scope : { ...scope, right, bottom, details };
}
