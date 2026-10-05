import { entityDragScopesEqualV1, type EntityDragItemV1 } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import type { PaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import type { SplitCanvasDropTarget } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { sessionCanvasTabId } from '@/sync/domains/session/sessionSplitCanvasPersistence';
import { findSessionCanvasTab, findSessionLeafById, runSessionSplitCanvasCommand, type SessionCanvasSplitMeasurement, type SessionSplitCanvasCommand, type SessionSplitCanvasAction, type SessionSplitCanvasState } from './sessionSplitCanvasState';
import { areSessionSplitCanvasScopesCompatible, type SessionSplitCanvasScope } from '@/sync/domains/session/sessionSplitCanvasScope';
import type { SessionCanvasWorkspaceIdentity } from './sessionCanvasActions';

/** Geometry selects meaning; membership and measured admission stay with the canvas owner. */
export function planSessionSplitCanvasDropAction(input: Readonly<{
    state: SessionSplitCanvasState;
    item: EntityDragItemV1;
    target: SplitCanvasDropTarget;
    beforeTabId?: string | null;
    measurement?: SessionCanvasSplitMeasurement;
}>): SessionSplitCanvasAction | null {
    const { state, item, target } = input;
    if (!entityDragScopesEqualV1(state.scope, item.scope) || !findSessionLeafById(state, target.leafId)) return null;
    if (item.kind === 'workspace-tab') {
        const found = findSessionCanvasTab(state, item.tabId);
        if (!found) return null;
        if (target.placement === 'center') {
            const command = { type: 'moveTab', tabId: item.tabId, targetLeafId: target.leafId,
                ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }) } as const;
            return runSessionSplitCanvasCommand(state, command) === state ? null : command;
        }
        const command = { type: 'splitTab', tabId: item.tabId, targetLeafId: target.leafId, direction: target.placement, measurement: input.measurement } as const;
        return runSessionSplitCanvasCommand(state, command) === state ? null : command;
    }
    if (item.kind !== 'session' || item.address.serverId !== state.scope.serverId) return null;
    const existing = findSessionCanvasTab(state, sessionCanvasTabId(item.scope, item.address.sessionId));
    if (existing) return { type: 'activateTab', tabId: existing.tab.id };
    if (target.placement === 'center') return {
        type: 'openSession', sessionId: item.address.sessionId, leafId: target.leafId,
        ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }),
    };
    if (!input.measurement) return null;
    const action = { type: 'openSessionInSplit', sessionId: item.address.sessionId, leafId: target.leafId,
        direction: target.placement, measurement: input.measurement } satisfies SessionSplitCanvasCommand;
    return runSessionSplitCanvasCommand(state, action) === state ? null : action;
}

/** Portable pointer/chooser intent projects the same current canvas command; no measurement enters its Action input. */
export function resolveSessionCanvasEntityDrop(input: Readonly<{
    state: SessionSplitCanvasState;
    canvasKey: string;
    workspaceScope: SessionSplitCanvasScope;
    item: EntityDragItemV1;
    target: SplitCanvasDropTarget;
    beforeTabId?: string | null;
    measurement?: SessionCanvasSplitMeasurement;
    resolveWorkspaceScope: (identity: SessionCanvasWorkspaceIdentity) => SessionSplitCanvasScope | null;
}>): PaneDropAdmission {
    const refuse = (code: string): PaneDropAdmission => ({ status: 'refused', reason: { code } });
    const { state, item, target } = input;
    if (!entityDragScopesEqualV1(state.scope, item.scope)) return refuse('canvas_scope_changed');
    if (input.canvasKey !== input.workspaceScope.workspaceCacheKey || !findSessionLeafById(state, target.leafId)) return refuse('canvas_leaf_not_found');
    const found = item.kind === 'workspace-tab' ? findSessionCanvasTab(state, item.tabId) : null;
    const sessionId = item.kind === 'session' && item.address.serverId === state.scope.serverId ? item.address.sessionId : found?.tab.address.sessionId;
    if (!sessionId) return refuse(item.kind === 'workspace-tab' ? 'canvas_tab_not_found' : 'canvas_kind_unsupported');
    if (!areSessionSplitCanvasScopesCompatible(input.workspaceScope, input.resolveWorkspaceScope({ ...item.scope, sessionId }))) return refuse('session_workspace_unavailable');
    const command = planSessionSplitCanvasDropAction(input);
    if (!command) {
        if (target.placement !== 'center' && found?.leaf.id === target.leafId && found.leaf.payload.group.tabIds.length === 1) {
            return refuse('canvas_tab_cannot_split_own_pane');
        }
        if (target.placement === 'center' && found?.leaf.id === target.leafId) return refuse('already_here');
        return refuse(target.placement !== 'center' && !input.measurement ? 'canvas_layout_unmeasured' : 'canvas_operation_unavailable');
    }
    const common = { scope: item.scope, canvasKey: input.canvasKey };
    if (command.type === 'activateTab') return { status: 'allowed', effect: { actionId: 'session.canvas.tabs.activate', input: { ...common, tabId: command.tabId } } };
    if (item.kind === 'workspace-tab') return { status: 'allowed', effect: { actionId: 'session.canvas.tabs.move', input: {
        ...common, tabId: item.tabId, targetLeafId: target.leafId, placement: target.placement,
        ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }),
    } } };
    return { status: 'allowed', effect: { actionId: 'session.canvas.tabs.open', input: {
        ...common, sessionId, leafId: target.leafId, placement: target.placement,
        ...(input.beforeTabId === undefined ? {} : { beforeTabId: input.beforeTabId }),
    } } };
}
