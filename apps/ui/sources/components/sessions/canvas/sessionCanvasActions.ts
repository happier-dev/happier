import { SESSION_CANVAS_ACTION_INPUT_SCHEMAS, type SessionCanvasActionOutcome } from '@happier-dev/protocol/actions/sessionCanvasActionFamily';
import type { SessionCanvasActionId } from '@happier-dev/protocol/actions/sessionCanvasActionIds';
import type { z } from 'zod';
import { entityDragScopesEqualV1 } from '@happier-dev/protocol/plugins/ui';
import { collectSplitCanvasLeaves } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import type { SplitCanvasHostControls } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import type { SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import { findSessionCanvasTab, findSessionLeafById, type SessionSplitCanvasAction, type SessionSplitCanvasState } from './sessionSplitCanvasState';
import { planSessionSplitCanvasDropAction } from './planSessionSplitCanvasDropAction';

export type SessionCanvasWorkspaceIdentity = Readonly<{ serverId: string; accountId: string; sessionId: string }>;
type ParsedSessionCanvasRequest = {
    [Id in SessionCanvasActionId]: Readonly<{ actionId: Id; data: z.output<(typeof SESSION_CANVAS_ACTION_INPUT_SCHEMAS)[Id]> }>;
}[SessionCanvasActionId];
export function createSessionCanvasActionAdapter(input: Readonly<{
    canvasKey: string;
    getState: () => SessionSplitCanvasState;
    dispatch: (action: SessionSplitCanvasAction) => SessionSplitCanvasState;
    readCanvas: () => SplitCanvasHostControls | null;
    getWorkspaceScope: (identity: SessionCanvasWorkspaceIdentity) => SessionSplitCanvasScope | null;
}>) {
    return (actionId: SessionCanvasActionId, parameters: unknown): SessionCanvasActionOutcome => {
        const parsed = SESSION_CANVAS_ACTION_INPUT_SCHEMAS[actionId].safeParse(parameters);
        const refuse = (reason: string): SessionCanvasActionOutcome => ({ status: 'refused', reason });
        if (!parsed.success) return refuse('invalid_parameters');
        // The indexed schema validated exactly this action's input; preserve that correlation for narrowing.
        const request = { actionId, data: parsed.data } as ParsedSessionCanvasRequest;
        const { actionId: parsedActionId, data } = request;
        const state = input.getState();
        if (data.canvasKey !== input.canvasKey || !entityDragScopesEqualV1(data.scope, state.scope)) return refuse('canvas_scope_changed');
        if (parsedActionId === 'session.canvas.tabs.list') {
            const leaves = collectSplitCanvasLeaves(state.root);
            return { status: 'listed', focusedLeafId: state.focusedLeafId, maximizedLeafId: state.maximizedLeafId,
                leaves: leaves.map(leaf => ({ id: leaf.id, tabIds: [...leaf.payload.group.tabIds], activeTabId: leaf.payload.group.activeTabId })),
                tabs: leaves.flatMap(leaf => leaf.payload.group.tabIds.map(id => {
                    const tab = leaf.payload.tabs[id];
                    return { id, leafId: leaf.id, address: tab.address, pinned: tab.pinned, preview: tab.preview };
                })),
            };
        }
        let action: SessionSplitCanvasAction | null = null;
        if (parsedActionId === 'session.canvas.tabs.open' && 'sessionId' in data) {
            const sourceWorkspace = input.getWorkspaceScope({ ...data.scope, sessionId: data.sessionId });
            if (!sourceWorkspace || sourceWorkspace.workspaceCacheKey !== input.canvasKey) return refuse('session_workspace_unavailable');
            if (!findSessionLeafById(state, data.leafId)) return refuse('canvas_leaf_not_found');
            const measurement = data.placement === 'center' ? null : input.readCanvas()?.readSplitMeasurement(data.leafId, data.placement);
            action = planSessionSplitCanvasDropAction({ state, item: { kind: 'session', scope: data.scope, address: { serverId: data.scope.serverId, sessionId: data.sessionId } },
                target: { leafId: data.leafId, placement: data.placement }, beforeTabId: data.beforeTabId, ...(measurement ? { measurement } : {}),
            });
        } else if ('tabId' in data) {
            const found = findSessionCanvasTab(state, data.tabId);
            if (!found) return refuse('canvas_tab_not_found');
            if (parsedActionId !== 'session.canvas.tabs.close') {
                const sourceWorkspace = input.getWorkspaceScope({ ...data.scope, sessionId: found.tab.address.sessionId });
                if (sourceWorkspace?.workspaceCacheKey !== input.canvasKey) return refuse('session_workspace_unavailable');
            }
            switch (parsedActionId) {
                case 'session.canvas.tabs.activate': action = { type: 'activateTab', tabId: data.tabId }; break;
                case 'session.canvas.tabs.close': action = { type: 'closeTab', tabId: data.tabId }; break;
                case 'session.canvas.tabs.reorder':
                    if ('beforeTabId' in data) action = { type: 'reorderTab', tabId: data.tabId, beforeTabId: data.beforeTabId ?? null };
                    break;
                case 'session.canvas.tabs.pin':
                    if ('pinned' in data) action = { type: 'setPinned', tabId: data.tabId, pinned: data.pinned };
                    break;
                case 'session.canvas.tabs.move': {
                    if (!('targetLeafId' in data) || !findSessionLeafById(state, data.targetLeafId)) return refuse('canvas_leaf_not_found');
                    if (data.placement === 'center') action = { type: 'moveTab', tabId: data.tabId, targetLeafId: data.targetLeafId, beforeTabId: data.beforeTabId };
                    else {
                        const measurement = input.readCanvas()?.readSplitMeasurement(data.targetLeafId, data.placement);
                        action = planSessionSplitCanvasDropAction({ state, item: { kind: 'workspace-tab', scope: data.scope, tabId: data.tabId },
                            target: { leafId: data.targetLeafId, placement: data.placement }, ...(measurement ? { measurement } : {}),
                        });
                    }
                    break;
                }
            }
        }
        if (!action) return refuse('canvas_operation_unavailable');
        const next = input.dispatch(action);
        return { status: next === state ? 'unchanged' : 'applied' };
    };
}
