import { WORKSPACE_ACTION_INPUT_SCHEMAS, type WorkspaceActionId, type WorkspaceTabsListOutput, type WorkspaceClosedTabsListOutput } from '@happier-dev/protocol/actions/workspaceActionFamily';
import type { z } from 'zod';
import type { SplitCanvasHostControls } from '../splitCanvas/components/SplitCanvasHost';
import { createWorkspaceEmptyTab, type WorkspaceState } from './workspaceState';
import type { createWorkspaceNavigationAdapter } from './workspaceNavigationAdapter';
import { createWorkspaceSplit } from './workspaceSplit';
import type { FileFindSeedHandoff } from '../panes/fileFindSeedHandoff';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type WorkspaceActionOutcome = Readonly<{ ok: true }> | WorkspaceTabsListOutput | WorkspaceClosedTabsListOutput
    | Readonly<{ ok: false; errorCode: string; error: string }>;
type ParsedWorkspaceRequest = {
    [Id in WorkspaceActionId]: Readonly<{ actionId: Id; data: z.output<(typeof WORKSPACE_ACTION_INPUT_SCHEMAS)[Id]> }>;
}[WorkspaceActionId];

export function workspaceActionFailure(errorCode: string): WorkspaceActionOutcome {
    return { ok: false, errorCode, error: errorCode };
}

export function projectWorkspaceTabsList(state: WorkspaceState): WorkspaceTabsListOutput {
    const splits: WorkspaceTabsListOutput['splits'] = [];
    const collectSplits = (node: WorkspaceState['root']) => {
        if (node.kind !== 'split') return;
        splits.push({ id: node.id, axis: node.axis, ratio: node.ratio, firstNodeId: node.first.id, secondNodeId: node.second.id });
        collectSplits(node.first); collectSplits(node.second);
    };
    collectSplits(state.root);
    return { ok: true,
        tabs: Object.values(state.groups).flatMap((group) => group.tabIds.map((id) => {
            const tab = state.tabs[id];
            return { id: tab.id, groupId: group.id, target: { kind: tab.target.kind, params: { ...tab.target.params } },
                pinned: tab.pinned, preview: tab.preview };
        })),
        groups: Object.values(state.groups).map((group) => ({ id: group.id, tabIds: [...group.tabIds], activeTabId: group.activeTabId })),
        splits, rootNodeId: state.root.id, focusedGroupId: state.focusedGroupId, maximizedGroupId: state.maximizedGroupId,
    };
}

/** Thin intent adapter. Navigation, preview policy, layout admission and persistence keep their existing owners. */
export function createWorkspaceActionAdapter(input: Readonly<{
    getState: () => WorkspaceState;
    navigation: ReturnType<typeof createWorkspaceNavigationAdapter>;
    readCanvas: () => SplitCanvasHostControls | null;
    createId: () => string;
    phone?: boolean;
    chatFind?: Readonly<{ handoff: FileFindSeedHandoff; resolveAuthority(serverId: string): ServerAccountScopeLifetime | null }>;
}>) {
    return (actionId: WorkspaceActionId, parameters: unknown): WorkspaceActionOutcome => {
        const parsed = WORKSPACE_ACTION_INPUT_SCHEMAS[actionId].safeParse(parameters);
        if (!parsed.success) return workspaceActionFailure('invalid_parameters');
        // The indexed schema validated exactly this action's input; preserve that correlation for narrowing.
        const request = { actionId, data: parsed.data } as ParsedWorkspaceRequest;
        const { actionId: parsedActionId, data } = request;
        if (input.phone && (parsedActionId === 'workspace.tabs.move' || parsedActionId.startsWith('workspace.groups.')
            || parsedActionId === 'workspace.split' || parsedActionId === 'workspace.resize'
            || (parsedActionId === 'workspace.tabs.open' && (!('href' in data) || !data.href
                || ('mode' in data && data.mode?.startsWith('split')))))) {
            return workspaceActionFailure('workspace_operation_unavailable');
        }
        const state = input.getState();
        if (parsedActionId === 'workspace.tabs.closed.list') return { ok: true, tabs: state.recentlyClosed.map(entry => ({
            id: entry.tab.id, target: { kind: entry.tab.target.kind, params: { ...entry.tab.target.params } }, pinned: entry.tab.pinned,
            ...(entry.fallbackTitle === undefined ? {} : { title: entry.fallbackTitle }),
        })) };
        if (parsedActionId === 'workspace.tabs.reopen') return input.navigation.reopenTab('tabId' in data ? data.tabId : undefined)
            ? { ok: true } : workspaceActionFailure('workspace_closed_tab_not_found');
        const requestedGroupId = 'groupId' in data && data.groupId ? data.groupId : undefined;
        const tabId = 'tabId' in data ? data.tabId : undefined;
        const source = tabId ? Object.values(state.groups).find((group) => group.tabIds.includes(tabId)) : state.groups[requestedGroupId ?? state.focusedGroupId];
        const groupId = requestedGroupId ?? source?.id ?? state.focusedGroupId;
        if (tabId && !source) return workspaceActionFailure('workspace_tab_not_found');
        if ('groupId' in data && data.groupId && !state.groups[data.groupId]) return workspaceActionFailure('workspace_group_not_found');
        switch (parsedActionId) {
            case 'workspace.tabs.list': return projectWorkspaceTabsList(state);
            case 'workspace.tabs.open':
                if ('href' in data && data.href) {
                    const mode = 'mode' in data && data.mode ? data.mode : 'newTab';
                    const reuseExisting = 'reuseExisting' in data ? data.reuseExisting ?? true : true;
                    const direction = mode === 'splitLeft' ? 'left' : mode === 'splitRight' ? 'right'
                        : mode === 'splitUp' ? 'up' : mode === 'splitDown' ? 'down' : null;
                    const alreadyOpen = reuseExisting ? input.navigation.findOpenHref(data.href) : null;
                    const measurement = direction && !alreadyOpen
                        ? input.readCanvas()?.readSplitMeasurement(groupId, direction) : null;
                    if (direction && !measurement && !alreadyOpen) {
                        return workspaceActionFailure('workspace_layout_unmeasured');
                    }
                    let cancelFind: (() => void) | undefined;
                    if (data.find) {
                        const target = input.navigation.resolveOpenTarget(data.href);
                        const serverId = target?.params.serverId;
                        const authority = serverId ? input.chatFind?.resolveAuthority(serverId) : null;
                        if (target?.kind !== 'session' || !target.params.id || !input.chatFind || !authority?.isCurrent()
                            || (target.params.accountId && target.params.accountId !== authority.scope.accountId)) {
                            return workspaceActionFailure('workspace_find_unavailable');
                        }
                        cancelFind = input.chatFind.handoff.stageChat({ sessionId: target.params.id,
                            serverId: authority.scope.serverId, accountId: authority.scope.accountId }, data.find, authority);
                        if (!authority.isCurrent()) { cancelFind(); return workspaceActionFailure('workspace_find_unavailable'); }
                    }
                    try {
                        if (!input.navigation.openHref(data.href, {
                            ...(tabId ? { tabId } : {}),
                            ...('groupId' in data && data.groupId ? { groupId: data.groupId } : {}),
                            ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                            mode, reuseExisting,
                            ...(measurement ? { availableSizePx: measurement.availableSizePx, minimumFirstSizePx: measurement.minimumExistingSizePx } : {}),
                        })) { cancelFind?.(); return workspaceActionFailure('workspace_destination_unavailable'); }
                    } catch (error) { cancelFind?.(); throw error; }
                } else {
                    if (tabId) return workspaceActionFailure('invalid_parameters');
                    input.navigation.dispatch({ type: 'openTab', groupId, tab: createWorkspaceEmptyTab(input.createId()),
                        ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                    });
                }
                break;
            case 'workspace.tabs.activate':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                input.navigation.activateTab(source.id, tabId);
                break;
            case 'workspace.tabs.close':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                input.navigation.closeTab(source.id, tabId);
                break;
            case 'workspace.tabs.pin':
                if (tabId && 'pinned' in data) input.navigation.dispatch({ type: 'setPinned', tabId, pinned: data.pinned });
                break;
            case 'workspace.tabs.move':
                if (!tabId || !source || !('targetGroupId' in data) || !state.groups[data.targetGroupId]) return workspaceActionFailure('workspace_group_not_found');
                input.navigation.dispatch({ type: 'moveTab', tabId, sourceGroupId: source.id, targetGroupId: data.targetGroupId,
                    ...('beforeTabId' in data ? { beforeTabId: data.beforeTabId } : {}),
                });
                break;
            case 'workspace.tabs.reorder':
                if (!tabId || !source) return workspaceActionFailure('workspace_tab_not_found');
                if ('index' in data) {
                    if (data.index >= source.tabIds.length) return workspaceActionFailure('workspace_tab_index_out_of_range');
                    input.navigation.dispatch({ type: 'reorderTab', groupId: source.id, tabId, index: data.index });
                } else if ('beforeTabId' in data) {
                    input.navigation.dispatch({ type: 'reorderTab', groupId: source.id, tabId, beforeTabId: data.beforeTabId });
                }
                break;
            case 'workspace.groups.focus': input.navigation.dispatch({ type: 'focusGroup', groupId }); break;
            case 'workspace.groups.maximize':
                if (state.maximizedGroupId !== groupId) input.navigation.dispatch({ type: 'toggleMaximize', groupId });
                break;
            case 'workspace.groups.restore': input.navigation.dispatch({ type: 'restoreMaximize' }); break;
            case 'workspace.split': {
                if (!source || !('direction' in data)) return workspaceActionFailure('workspace_group_not_found');
                const measurement = input.readCanvas()?.readSplitMeasurement(groupId, data.direction);
                if (!measurement) return workspaceActionFailure('workspace_layout_unmeasured');
                const action = createWorkspaceSplit(state, { groupId, ...(tabId ? { tabId } : {}), direction: data.direction,
                    ...measurement, createId: input.createId });
                if (!action) return workspaceActionFailure('workspace_split_unavailable');
                input.navigation.dispatch(action);
                break;
            }
            case 'workspace.resize':
                if (!('splitId' in data) || !('ratio' in data) || !input.readCanvas()?.resizeSplit(data.splitId, data.ratio)) return workspaceActionFailure('workspace_layout_unmeasured');
                break;
        }
        return { ok: true };
    };
}
