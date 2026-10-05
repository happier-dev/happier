import { entityDragScopesEqualV1, type EntityDragScopeV1 } from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import { splitCanvasReduce } from '@/components/appShell/splitCanvas/model/splitCanvasReducer';
import { collectSplitCanvasLeaves, findSplitCanvasLeaf, getFirstSplitCanvasLeafId } from '@/components/appShell/splitCanvas/model/splitCanvasTree';
import type { SplitCanvasAction, SplitCanvasDirection, SplitCanvasLeafNode, SplitCanvasState } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { activateGroupTab, closeGroupTab, insertGroupTab, moveGroupTab, reorderGroupTab } from '@/components/appShell/workspace/tabGroups/tabGroupTransitions';
import { WORKSPACE_VIEW_MINIMUM } from '@/components/appShell/workspace/workspaceSplit';
import { createInitialSessionSplitCanvasSnapshot, createSessionCanvasTab, createSessionSplitCanvasLeafNode, sessionCanvasTabId, type SessionCanvasTab, type SessionSplitCanvasLeafPayload, type SessionSplitCanvasPersistenceSnapshot } from '@/sync/domains/session/sessionSplitCanvasPersistence';

export type SessionSplitCanvasState = SplitCanvasState<SessionSplitCanvasLeafPayload> & Readonly<{ scope: EntityDragScopeV1 }>;
export type SessionCanvasSplitMeasurement = Readonly<{ availableSizePx: number; minimumExistingSizePx: number }>;
export type SessionSplitCanvasCommand =
    | Readonly<{ type: 'openSession'; sessionId: string; leafId: string; beforeTabId?: string | null }>
    | Readonly<{ type: 'openSessionInSplit'; sessionId: string; direction: SplitCanvasDirection; leafId?: string; measurement?: SessionCanvasSplitMeasurement }>
    | Readonly<{ type: 'focusSession'; sessionId: string }>
    | Readonly<{ type: 'activateTab'; tabId: string }>
    | Readonly<{ type: 'closeTab'; tabId: string }>
    | Readonly<{ type: 'moveTab'; tabId: string; targetLeafId: string; beforeTabId?: string | null }>
    | Readonly<{ type: 'splitTab'; tabId: string; targetLeafId: string; direction: SplitCanvasDirection; measurement?: SessionCanvasSplitMeasurement }>
    | Readonly<{ type: 'reorderTab'; tabId: string; beforeTabId: string | null }>
    | Readonly<{ type: 'setPinned'; tabId: string; pinned: boolean }>;
export type SessionSplitCanvasAction = SplitCanvasAction<SessionSplitCanvasLeafPayload> | SessionSplitCanvasCommand;

export function findSessionLeafById(state: SessionSplitCanvasState, leafId: string | null | undefined) {
    return leafId ? findSplitCanvasLeaf(state.root, leafId) : null;
}
export function findSessionCanvasTab(state: SessionSplitCanvasState, tabId: string): Readonly<{ leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>; tab: SessionCanvasTab }> | null {
    for (const leaf of collectSplitCanvasLeaves(state.root)) {
        if (leaf.payload.group.tabIds.includes(tabId)) return { leaf, tab: leaf.payload.tabs[tabId] };
    }
    return null;
}
export function findSessionLeafIdBySessionId(state: SessionSplitCanvasState, sessionId: string): string | null {
    return findSessionCanvasTab(state, sessionCanvasTabId(state.scope, sessionId))?.leaf.id ?? null;
}
export function activeSessionForLeaf(leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload> | null | undefined): SessionCanvasTab | null {
    const id = leaf?.payload.group.activeTabId;
    return id && leaf ? leaf.payload.tabs[id] ?? null : null;
}
function withPayload(state: SessionSplitCanvasState, leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>, payload: SessionSplitCanvasLeafPayload): SessionSplitCanvasState {
    if (payload === leaf.payload) return state;
    return { ...splitCanvasReduce(state, { type: 'replaceLeaf', leafId: leaf.id, nextLeaf: { ...leaf, payload } }), scope: state.scope };
}
function layout(state: SessionSplitCanvasState, action: SplitCanvasAction<SessionSplitCanvasLeafPayload>): SessionSplitCanvasState {
    const next = splitCanvasReduce(state, action);
    return next === state ? state : { ...next, scope: state.scope };
}
function nextSessionLeaf(state: SessionSplitCanvasState, sessionId: string): SplitCanvasLeafNode<SessionSplitCanvasLeafPayload> {
    const base = createSessionSplitCanvasLeafNode(sessionId, state.scope);
    let id = base.id;
    while (findSessionLeafById(state, id)) id += ':split';
    return id === base.id ? base : { ...base, id, payload: { ...base.payload, group: { ...base.payload.group, id } } };
}
function activate(state: SessionSplitCanvasState, tabId: string): SessionSplitCanvasState {
    const found = findSessionCanvasTab(state, tabId);
    if (!found) return state;
    const group = activateGroupTab(found.leaf.payload.group, tabId);
    const next = group === found.leaf.payload.group ? state : withPayload(state, found.leaf, { ...found.leaf.payload, group });
    return layout(next, { type: 'focusLeaf', leafId: found.leaf.id });
}
function open(state: SessionSplitCanvasState, command: Extract<SessionSplitCanvasCommand, { type: 'openSession' }>): SessionSplitCanvasState {
    const existing = findSessionCanvasTab(state, sessionCanvasTabId(state.scope, command.sessionId));
    if (existing) return activate(state, existing.tab.id);
    const leaf = findSessionLeafById(state, command.leafId);
    if (!leaf) return state;
    const tab = createSessionCanvasTab(command.sessionId, state.scope);
    const group = insertGroupTab(leaf.payload.group, tab.id, command.beforeTabId);
    const next = withPayload(state, leaf, { group, tabs: { ...leaf.payload.tabs, [tab.id]: tab } });
    return layout(next, { type: 'focusLeaf', leafId: leaf.id });
}
function closeTab(state: SessionSplitCanvasState, tabId: string): SessionSplitCanvasState {
    const found = findSessionCanvasTab(state, tabId);
    if (!found || collectOpenSessionIds(state).length === 1) return state;
    const group = closeGroupTab(found.leaf.payload.group, tabId);
    if (group.tabIds.length === 0) return layout(state, { type: 'closeLeaf', leafId: found.leaf.id });
    const tabs = { ...found.leaf.payload.tabs };
    delete tabs[tabId];
    return withPayload(state, found.leaf, { group, tabs });
}

export function runSessionSplitCanvasCommand(state: SessionSplitCanvasState, command: SessionSplitCanvasCommand): SessionSplitCanvasState {
    switch (command.type) {
        case 'focusSession': return activate(state, sessionCanvasTabId(state.scope, command.sessionId));
        case 'activateTab': return activate(state, command.tabId);
        case 'openSession': return open(state, command);
        case 'openSessionInSplit': {
            const existing = findSessionCanvasTab(state, sessionCanvasTabId(state.scope, command.sessionId));
            if (existing) return activate(state, existing.tab.id);
            const leafId = command.leafId ?? state.focusedLeafId ?? getFirstSplitCanvasLeafId(state.root);
            if (!leafId || !command.measurement) return state;
            const axis = command.direction === 'left' || command.direction === 'right' ? 'row' : 'column';
            return layout(state, { type: 'splitLeaf', targetLeafId: leafId, axis,
                placement: command.direction === 'left' || command.direction === 'up' ? 'before' : 'after',
                newLeaf: nextSessionLeaf(state, command.sessionId),
                availableSizePx: command.measurement.availableSizePx,
                minimumFirstSizePx: command.measurement.minimumExistingSizePx,
                minimumSecondSizePx: axis === 'row' ? WORKSPACE_VIEW_MINIMUM.width : WORKSPACE_VIEW_MINIMUM.height,
            });
        }
        case 'closeTab': return closeTab(state, command.tabId);
        case 'splitTab': {
            const found = findSessionCanvasTab(state, command.tabId);
            const target = findSessionLeafById(state, command.targetLeafId);
            if (!found || !target || !command.measurement
                || (found.leaf.id === target.id && found.leaf.payload.group.tabIds.length === 1)) return state;
            const base = nextSessionLeaf(state, found.tab.address.sessionId);
            const leafId = base.id;
            const newLeaf = { ...base, payload: { group: base.payload.group, tabs: { [found.tab.id]: found.tab } } };
            const axis = command.direction === 'left' || command.direction === 'right' ? 'row' : 'column';
            let next = layout(state, { type: 'splitLeaf', targetLeafId: target.id, axis,
                placement: command.direction === 'left' || command.direction === 'up' ? 'before' : 'after', newLeaf,
                availableSizePx: command.measurement.availableSizePx,
                minimumFirstSizePx: command.measurement.minimumExistingSizePx,
                minimumSecondSizePx: axis === 'row' ? WORKSPACE_VIEW_MINIMUM.width : WORKSPACE_VIEW_MINIMUM.height,
            });
            if (next === state) return state;
            const group = closeGroupTab(found.leaf.payload.group, command.tabId);
            const tabs = { ...found.leaf.payload.tabs };
            delete tabs[command.tabId];
            next = group.tabIds.length ? withPayload(next, found.leaf, { group, tabs })
                : layout(next, { type: 'closeLeaf', leafId: found.leaf.id });
            return layout(next, { type: 'focusLeaf', leafId });
        }
        case 'moveTab': {
            const found = findSessionCanvasTab(state, command.tabId);
            const target = findSessionLeafById(state, command.targetLeafId);
            if (!found || !target) return state;
            if (found.leaf.id === target.id) return command.beforeTabId === undefined ? state
                : runSessionSplitCanvasCommand(state, { type: 'reorderTab', tabId: command.tabId, beforeTabId: command.beforeTabId });
            const moved = moveGroupTab(found.leaf.payload.group, target.payload.group, found.tab, target.payload.tabs, command.beforeTabId);
            const sourceTabs = { ...found.leaf.payload.tabs };
            delete sourceTabs[command.tabId];
            const targetTabs = { ...target.payload.tabs, [command.tabId]: found.tab };
            for (const id of moved.replacedPreviewTabIds) delete targetTabs[id];
            let next = withPayload(state, target, { group: moved.target, tabs: targetTabs });
            next = moved.source.tabIds.length ? withPayload(next, found.leaf, { group: moved.source, tabs: sourceTabs })
                : layout(next, { type: 'closeLeaf', leafId: found.leaf.id });
            return layout(next, { type: 'focusLeaf', leafId: target.id });
        }
        case 'reorderTab': {
            const found = findSessionCanvasTab(state, command.tabId);
            if (!found) return state;
            const group = reorderGroupTab(found.leaf.payload.group, command.tabId, command.beforeTabId);
            return group === found.leaf.payload.group ? state : withPayload(state, found.leaf, { ...found.leaf.payload, group });
        }
        case 'setPinned': {
            const found = findSessionCanvasTab(state, command.tabId);
            if (!found || found.tab.pinned === command.pinned) return state;
            return withPayload(state, found.leaf, { ...found.leaf.payload, tabs: { ...found.leaf.payload.tabs,
                [command.tabId]: { ...found.tab, pinned: command.pinned, preview: command.pinned ? false : found.tab.preview },
            } });
        }
    }
}
export function resolveSessionSplitCanvasState(input: Readonly<{
    sessionId: string; scope: EntityDragScopeV1; persistedSnapshot?: SessionSplitCanvasPersistenceSnapshot | null;
}>): SessionSplitCanvasState {
    const snapshot = input.persistedSnapshot && entityDragScopesEqualV1(input.persistedSnapshot.scope, input.scope)
        ? input.persistedSnapshot : createInitialSessionSplitCanvasSnapshot(input);
    const state: SessionSplitCanvasState = { ...snapshot, maxLeaves: Number.POSITIVE_INFINITY };
    if (!state.root) return { ...createInitialSessionSplitCanvasSnapshot(input), maxLeaves: Number.POSITIVE_INFINITY };
    // Reload restores the selected tab; a missing route member is added without displacing work.
    return findSessionLeafIdBySessionId(state, input.sessionId) ? state : reconcileSessionSplitCanvasRouteAnchor(state, input.sessionId);
}
export function reconcileSessionSplitCanvasRouteAnchor(state: SessionSplitCanvasState, sessionId: string): SessionSplitCanvasState {
    if (!sessionId.trim()) return state;
    const existing = findSessionCanvasTab(state, sessionCanvasTabId(state.scope, sessionId));
    if (existing) return activate(state, existing.tab.id);
    const leafId = state.focusedLeafId ?? getFirstSplitCanvasLeafId(state.root);
    return leafId ? open(state, { type: 'openSession', sessionId, leafId }) : state;
}
export function collectOpenSessionIds(state: SessionSplitCanvasState): string[] {
    return collectSplitCanvasLeaves(state.root).flatMap(leaf => leaf.payload.group.tabIds.map(id => leaf.payload.tabs[id].address.sessionId));
}
export function resolveSessionSplitCanvasRouteAnchorLeafId(state: SessionSplitCanvasState, routeSessionId: string): string | null {
    return findSessionLeafIdBySessionId(state, routeSessionId) ?? state.focusedLeafId ?? getFirstSplitCanvasLeafId(state.root);
}
export type SessionSplitCanvasKeyboardTargetSource = 'focused' | 'lastInteracted' | 'route' | 'composer';
export type SessionSplitCanvasKeyboardTarget = Readonly<{ leafId: string; sessionId: string; source: SessionSplitCanvasKeyboardTargetSource }>;
export function resolveSessionSplitCanvasKeyboardTarget(state: SessionSplitCanvasState, options: Readonly<{
    routeSessionId: string; lastInteractedLeafId?: string | null; composerOwningLeafId?: string | null; targetKind: 'session' | 'composer';
}>): SessionSplitCanvasKeyboardTarget | null {
    const fromLeaf = (id: string | null | undefined, source: SessionSplitCanvasKeyboardTargetSource): SessionSplitCanvasKeyboardTarget | null => {
        if (!id || (state.maximizedLeafId && state.maximizedLeafId !== id)) return null;
        const tab = activeSessionForLeaf(findSessionLeafById(state, id));
        return tab ? { leafId: id, sessionId: tab.address.sessionId, source } : null;
    };
    if (options.targetKind === 'composer') return fromLeaf(options.composerOwningLeafId, 'composer');
    return fromLeaf(state.focusedLeafId, 'focused') ?? fromLeaf(options.lastInteractedLeafId, 'lastInteracted')
        ?? (options.routeSessionId.trim() ? fromLeaf(resolveSessionSplitCanvasRouteAnchorLeafId(state, options.routeSessionId), 'route') : null);
}
export function reduceSessionSplitCanvasState(state: SessionSplitCanvasState, action: SessionSplitCanvasAction, _options?: Readonly<{ routeSessionId: string }>): SessionSplitCanvasState {
    if (action.type === 'closeLeaf' && collectSplitCanvasLeaves(state.root).length <= 1) return state;
    switch (action.type) {
        case 'openSession': case 'openSessionInSplit': case 'focusSession': case 'activateTab': case 'closeTab': case 'moveTab': case 'splitTab': case 'reorderTab': case 'setPinned':
            return runSessionSplitCanvasCommand(state, action);
        default: return layout(state, action);
    }
}
export function resolveSessionSplitCanvasRouteSessionAfterAction(state: SessionSplitCanvasState, action: SessionSplitCanvasAction, options: Readonly<{ routeSessionId: string; committedState?: SessionSplitCanvasState }>): string | null {
    const next = options.committedState ?? reduceSessionSplitCanvasState(state, action, options);
    if (next === state || findSessionLeafIdBySessionId(next, options.routeSessionId)) return null;
    return activeSessionForLeaf(findSessionLeafById(next, next.focusedLeafId))?.address.sessionId ?? null;
}
export function routeSessionOwnsLeaf(state: SessionSplitCanvasState, leaf: SplitCanvasLeafNode<SessionSplitCanvasLeafPayload>, routeSessionId: string): boolean {
    return leaf.id === resolveSessionSplitCanvasRouteAnchorLeafId(state, routeSessionId);
}
