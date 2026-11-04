import { describe, expect, it } from 'vitest';

import {
    applyCloseDetailsTab,
    applyMoveDetailsTabToGroup,
    applyOpenDetailsTab,
    applyPinDetailsTab,
    applyUnpinDetailsTab,
    applySetDetailsTabState,
    applySetActiveDetailsTab,
    applySetDetailsSplitRatio,
    applyReplaceDetailsTab,
    applySplitDetailsGroup,
    createEmptyPaneDetailsState,
} from './detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState, serializeDetailsWorkspaceState } from './migrateLegacyDetailsWorkspaceState';
import { applyDetailsTabPresentation } from './detailsWorkspaceReducer';
import { buildDetailsWorkspaceStateView, resolveDetailsPresentationTabKey } from './detailsWorkspaceSelectors';
import { mergePaneScopePresentationState } from '../../model/paneScopePersistence';
import { createAppPaneState, appPaneReduce } from '../../model/appPaneReducer';
import { selectedPaneDestinationTabKey } from '../../model/selectedPaneDestination';

function openFile(state: ReturnType<typeof createEmptyPaneDetailsState>, name: string) {
    return applyOpenDetailsTab(state, {
        tab: { key: `file:${name}`, kind: 'file', title: name, resource: { path: name } },
        openAs: 'pinned',
    });
}

describe('Details tab group transitions', () => {
    it('commits an admitted recipient slot selection while ordinary draft writes preserve the source selection', () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 3 }), { type: 'openRight', scopeId: 'scope', tabId: 'first' });
        const tabKey = selectedPaneDestinationTabKey('right');
        state = appPaneReduce(state, { type: 'setSelectedPanePresentation', scopeId: 'scope', tabKey, presentation: { windowId: 'recipient' } });
        const source = state.scopes.scope;
        const recipient = appPaneReduce(state, { type: 'selectRightDestination', scopeId: 'scope', destination: { kind: 'builtin', id: 'second' } }).scopes.scope;
        expect(mergePaneScopePresentationState(recipient, source, tabKey).right.selectedDestination).toEqual(source.right.selectedDestination);
        const committed = mergePaneScopePresentationState(recipient, source, tabKey, tabKey);
        expect(committed.right.selectedDestination).toEqual({ kind: 'builtin', id: 'second' });
        expect(committed.right.presentation).toEqual({ windowId: 'recipient' });
        expect(committed.details).toBe(source.details);
        expect(mergePaneScopePresentationState(source, committed).right.selectedDestination).toEqual({ kind: 'builtin', id: 'second' });
    });
    it('keeps a placed tab in its window when a source resource is opened again', () => {
        const placed = applyDetailsTabPresentation(openFile(createEmptyPaneDetailsState(), 'a'), 'file:a', { windowId: 'window-a' });
        const reopened = openFile(placed, 'a');
        expect(reopened.tabsByKey['file:a'].presentation).toEqual({ windowId: 'window-a' });
        expect(buildDetailsWorkspaceStateView(reopened).tabs).toEqual([]);
    });
    it('keeps a placed preview while a source sibling opens another preview', () => {
        const original = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab: { key: 'file:a', kind: 'file', title: 'a', resource: {} }, openAs: 'preview' });
        const placed = applyDetailsTabPresentation(original, 'file:a', { windowId: 'window-a' });
        const next = applyOpenDetailsTab(placed, { tab: { key: 'file:b', kind: 'file', title: 'b', resource: {} }, openAs: 'preview' });
        expect(next.tabsByKey['file:a']).toEqual(placed.tabsByKey['file:a']);
        expect(buildDetailsWorkspaceStateView(next).tabs.map(tab => tab.key)).toEqual(['file:b']);
        const returned = applyDetailsTabPresentation(next, 'file:a', null);
        expect(returned.groupsById['group:1'].tabKeys).toEqual(['file:a', 'file:b']);
    });
    it('follows a viewer replacement through its existing original-file restoration identity', () => {
        const original = applyDetailsTabPresentation(openFile(createEmptyPaneDetailsState(), 'a'), 'file:a', { windowId: 'window-a' });
        const replaced = applyReplaceDetailsTab(original, { tabKey: 'file:a', tab: { key: 'viewer:a', kind: 'plugin', title: 'Viewer',
            resource: { kind: 'pluginDetailsDestination', destination: { pluginId: 'com.example.viewer', localId: 'file' } } }, restoreSourceOnRehydrate: true });
        expect(resolveDetailsPresentationTabKey(replaced, 'file:a')).toBe('viewer:a');
        expect(replaced.tabsByKey['viewer:a'].presentation).toEqual({ windowId: 'window-a' });
        expect(serializeDetailsWorkspaceState(replaced).tabsByKey['file:a'].presentation).toEqual({ windowId: 'window-a' });
    });
    it('preserves newer sibling edits while the recipient persists only its selected pane tab', () => {
        let state = createAppPaneState({ maxScopesInMemory: 12 });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'scope', tab: { key: 'file:a', kind: 'file', title: 'a', resource: {} }, openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'openDetailsTab', scopeId: 'scope', tab: { key: 'file:b', kind: 'file', title: 'b', resource: {} }, openAs: 'pinned' });
        state = appPaneReduce(state, { type: 'setDetailsTabPresentation', scopeId: 'scope', tabKey: 'file:a', presentation: { windowId: 'recipient' } });
        const original = state.scopes.scope;
        const recipient = { ...original, details: applySetDetailsTabState(original.details, 'file:a', { editorText: 'new recipient' }) };
        const source = { ...original, details: applySetDetailsTabState(original.details, 'file:b', { editorText: 'new sibling' }) };
        const fromRecipient = mergePaneScopePresentationState(recipient, source, 'file:a');
        expect(fromRecipient.details.tabState).toEqual({ 'file:a': { editorText: 'new recipient' }, 'file:b': { editorText: 'new sibling' } });
        const fromSource = mergePaneScopePresentationState(source, fromRecipient);
        expect(fromSource.details.tabState).toEqual(fromRecipient.details.tabState);
        expect(fromSource.details.groupsById).toBe(source.details.groupsById);
    });
    it('retains moved membership, sibling identity and persisted editor state while hiding only the placed tab', () => {
        let state = openFile(openFile(createEmptyPaneDetailsState(), 'a'), 'b');
        state = applySetDetailsTabState(state, 'file:b', { accountId: 'alice', editorText: 'unsaved', editorOriginalHash: 'base', scroll: 17 });
        const moved = applyDetailsTabPresentation(state, 'file:b', { windowId: 'window-a' });
        expect(moved.groupsById).toBe(state.groupsById);
        expect(moved.tabsByKey['file:a']).toBe(state.tabsByKey['file:a']);
        expect(moved.tabState).toBe(state.tabState);
        expect(buildDetailsWorkspaceStateView(moved).tabs.map(tab => tab.key)).toEqual(['file:a']);
        expect(buildDetailsWorkspaceStateView(moved).activeTabKey).toBe('file:a');
        const restored = migrateLegacyDetailsWorkspaceState(serializeDetailsWorkspaceState(moved));
        expect(restored.tabsByKey['file:b'].presentation).toEqual({ windowId: 'window-a' });
        expect(restored.tabState['file:b']).toEqual(state.tabState['file:b']);
        expect(applyDetailsTabPresentation(moved, 'file:b', { windowId: 'window-a' })).toBe(moved);
        const returned = applyDetailsTabPresentation(restored, 'file:b', null);
        expect(buildDetailsWorkspaceStateView(returned).tabs.map(tab => tab.key)).toEqual(['file:a', 'file:b']);
        expect(returned.groupsById['group:1'].tabKeys).toEqual(state.groupsById['group:1'].tabKeys);
    });
    it('publishes a real preview pin once and leaves an already-pinned tab unchanged', () => {
        const preview = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:a', kind: 'file', title: 'a', resource: { path: 'a' } }, openAs: 'preview',
        });
        const pinned = applyPinDetailsTab(preview, 'file:a');
        expect(pinned).not.toBe(preview);
        expect(pinned.tabsByKey['file:a']).toMatchObject({ isPinned: true, isPreview: false });
        for (let index = 0; index < 20; index += 1) expect(applyPinDetailsTab(pinned, 'file:a')).toBe(pinned);
    });

    it('keeps a dirty file pinned when unpin is followed by opening another preview', () => {
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'unsaved' };
        let state = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: { key: 'file:a', kind: 'file', title: 'a', resource: { path: 'a' } }, openAs: 'preview',
        });
        state = applySetDetailsTabState(state, 'file:a', draft);
        state = applyPinDetailsTab(state, 'file:a');
        state = applyUnpinDetailsTab(state, 'file:a');
        state = applyOpenDetailsTab(state, {
            tab: { key: 'file:b', kind: 'file', title: 'b', resource: { path: 'b' } }, openAs: 'preview',
        });
        expect(state.tabsByKey['file:a']).toMatchObject({ isPinned: true, isPreview: false });
        expect(state.tabState['file:a']).toEqual(draft);
    });
    it('returns to the most recently active surviving tab when the active tab closes', () => {
        let state = createEmptyPaneDetailsState();
        state = openFile(state, 'a');
        state = openFile(state, 'b');
        state = openFile(state, 'c');
        state = applySetActiveDetailsTab(state, 'file:a');
        state = applySetActiveDetailsTab(state, 'file:c');
        state = applySetActiveDetailsTab(state, 'file:b');

        state = applyCloseDetailsTab(state, 'file:b');

        expect(state.groupsById['group:1']?.activeTabKey).toBe('file:c');
    });

    it('moves a tab through nested split groups, resizes, collapses, and restores the Details tree', () => {
        let state = openFile(createEmptyPaneDetailsState(), 'a');
        state = applySplitDetailsGroup(state, { axis: 'vertical', groupId: 'group:1' });
        state = openFile(state, 'b');
        state = applySplitDetailsGroup(state, { axis: 'horizontal', groupId: 'group:2' });
        state = openFile(state, 'c');

        const outerSplitId = state.root?.id;
        expect(outerSplitId).toBeTruthy();
        state = applySetDetailsSplitRatio(state, outerSplitId!, 0.6);
        state = applyMoveDetailsTabToGroup(state, { tabKey: 'file:b', targetGroupId: 'group:3' });

        expect(state.groupsById['group:2']).toBeUndefined();
        expect(state.groupsById['group:3']?.tabKeys).toEqual(['file:c', 'file:b']);
        expect(state.focusedGroupId).toBe('group:3');
        expect(state.root).toMatchObject({ kind: 'split', axis: 'row', ratio: 0.6 });

        state = applyCloseDetailsTab(state, 'file:b');
        const restored = migrateLegacyDetailsWorkspaceState(serializeDetailsWorkspaceState(state));
        expect(restored.groupsById['group:3']?.activeTabKey).toBe('file:c');
        expect(restored.root).toEqual(state.root);
    });
});
