import { describe, expect, it } from 'vitest';
import { appPaneReduce, createAppPaneState } from './appPaneReducer';
import { enumerateSelectedPaneSlots, findSelectedPaneSlot, selectedPaneDestinationTabKey, isSelectedPaneSlotVisible, restorePaneDestinationSelection } from './selectedPaneDestination';
import { normalizePersistedPaneScopes, serializePersistedPaneScope, mergePaneScopePresentationState } from './paneScopePersistence';
import { PersistedPaneScopeSchema } from './paneScopePersistenceSchema';
import { activatePaneWindowTab } from '../paneTabWindowTransfer';
import type { AppPaneContextValue } from '../AppPaneContext';

describe('selected pane window placement', () => {
    it('activates the retained selected overlay without replacing its destination or sibling state', () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 10 }), { type: 'openDetailsOverlay', scopeId: 's',
            destination: { pluginId: 'com.example.pane', localId: 'overlay' }, instanceKey: 'original' });
        const retained = state.scopes.s;
        state = appPaneReduce(state, { type: 'restoreScope', scopeId: 's', scope: { ...retained,
            details: { ...retained.details, isOpen: false } } });
        const context: Pick<AppPaneContextValue, 'getReadState' | 'dispatch'> = {
            getReadState: () => state, dispatch(action) { state = appPaneReduce(state, action); },
        };
        activatePaneWindowTab(context, { kind: 'paneTab', serverId: 'home', accountId: 'account', layoutId: 'layout',
            scopeId: 's', tabKey: selectedPaneDestinationTabKey('detailsOverlay') });
        expect(state.scopes.s.details.isOpen).toBe(true);
        expect(state.scopes.s.details.overlay).toBe(retained.details.overlay);
        expect(state.scopes.s.right).toBe(retained.right);
        expect(state.scopes.s.bottom).toBe(retained.bottom);
    });
    it('rolls back a failed retarget selection while retaining the latest draft and sibling state', () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 10 }), { type: 'openBottom', scopeId: 's', tabId: 'terminal' });
        const previous = state.scopes.s;
        state = appPaneReduce(state, { type: 'setBottomTabState', scopeId: 's', tabId: 'terminal', nextState: 'flushed draft' });
        state = appPaneReduce(state, { type: 'selectBottomDestination', scopeId: 's', destination: { kind: 'builtin', id: 'logs' } });
        state = appPaneReduce(state, { type: 'openRight', scopeId: 's', tabId: 'files' });
        const current = state.scopes.s;
        const restored = restorePaneDestinationSelection(current, previous, selectedPaneDestinationTabKey('bottom'));
        expect(restored.bottom.selectedDestination).toEqual(previous.bottom.selectedDestination);
        expect(restored.bottom.tabState.terminal).toBe('flushed draft');
        expect(restored.right).toBe(current.right);
        expect(restored.details).toBe(current.details);
    });
    it('releases a placed source body and admits only the recipient addressed slot', () => {
        const source = { isOpen: true, presentation: { windowId: 'w' } };
        expect(isSelectedPaneSlotVisible(source, 'bottom')).toBe(false);
        expect(isSelectedPaneSlotVisible(source, 'bottom', selectedPaneDestinationTabKey('bottom'))).toBe(true);
        expect(isSelectedPaneSlotVisible({ isOpen: true }, 'right', selectedPaneDestinationTabKey('bottom'))).toBe(false);
    });
    it('keeps an overlay window placed while its canonical selection is retargeted', () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 10 }), { type: 'openDetailsOverlay', scopeId: 's',
            destination: { pluginId: 'com.example.pane', localId: 'first' } });
        const tabKey = selectedPaneDestinationTabKey('detailsOverlay');
        state = appPaneReduce(state, { type: 'setSelectedPanePresentation', scopeId: 's', tabKey, presentation: { windowId: 'w' } });
        const resourceId = findSelectedPaneSlot(state.scopes.s, tabKey)?.resourceId;
        state = appPaneReduce(state, { type: 'openDetailsOverlay', scopeId: 's', destination: { pluginId: 'com.example.pane', localId: 'second' } });
        expect(findSelectedPaneSlot(state.scopes.s, tabKey)?.presentation).toEqual({ windowId: 'w' });
        expect(findSelectedPaneSlot(state.scopes.s, tabKey)?.resourceId).not.toBe(resourceId);
        const persisted = PersistedPaneScopeSchema.parse(serializePersistedPaneScope(state.scopes.s, { preserveDesktopVisibility: false }));
        expect(findSelectedPaneSlot(normalizePersistedPaneScopes({ s: persisted }, true).s, tabKey)?.presentation).toEqual({ windowId: 'w' });
    });
    it('places the addressed slot without changing its terminal identity, sibling or selection and restores it', () => {
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 10 }), { type: 'openBottom', scopeId: 's', tabId: 'terminal' });
        state = appPaneReduce(state, { type: 'setBottomTabState', scopeId: 's', tabId: 'terminal', nextState: { terminalInstanceId: 'original' } });
        const before = state.scopes.s;
        const slot = enumerateSelectedPaneSlots(before)[0];
        expect(slot).toMatchObject({ slot: 'bottom', paneType: 'bottomPane' });
        state = appPaneReduce(state, { type: 'setSelectedPanePresentation', scopeId: 's', tabKey: slot.tabKey, presentation: { windowId: 'w' } });
        const placed = state.scopes.s;
        expect(placed.right).toBe(before.right);
        expect(placed.bottom.tabState).toBe(before.bottom.tabState);
        expect(placed.bottom.selectedDestination).toBe(before.bottom.selectedDestination);
        expect(findSelectedPaneSlot(placed, slot.tabKey)?.presentation).toEqual({ windowId: 'w' });
        expect(appPaneReduce(state, { type: 'setSelectedPanePresentation', scopeId: 's', tabKey: slot.tabKey, presentation: { windowId: 'w' } })).toBe(state);
        const persisted = PersistedPaneScopeSchema.parse(serializePersistedPaneScope(placed, { preserveDesktopVisibility: false }));
        const restored = normalizePersistedPaneScopes({ s: persisted }, true).s;
        expect(findSelectedPaneSlot(restored, slot.tabKey)?.presentation).toEqual({ windowId: 'w' });
        state = appPaneReduce(state, { type: 'setSelectedPanePresentation', scopeId: 's', tabKey: slot.tabKey, presentation: null });
        expect(state.scopes.s.bottom.tabState).toBe(before.bottom.tabState);
        expect(findSelectedPaneSlot(state.scopes.s, slot.tabKey)?.presentation).toBeUndefined();
    });

    it('disambiguates slots and opaque plugin identities and merges only presented content', () => {
        const destination = { kind: 'plugin' as const, destination: { pluginId: 'com.example.pane', localId: 'a/b' }, instanceKey: 'one' };
        expect(selectedPaneDestinationTabKey('right')).not.toBe(selectedPaneDestinationTabKey('bottom'));
        let state = appPaneReduce(createAppPaneState({ maxScopesInMemory: 10 }), { type: 'selectRightDestination', scopeId: 's', destination });
        const source = state.scopes.s;
        state = appPaneReduce(state, { type: 'setRightTabState', scopeId: 's', tabId: 'draft', nextState: 'edited' });
        const key = selectedPaneDestinationTabKey('right');
        const merged = mergePaneScopePresentationState(state.scopes.s, source, key);
        expect(merged.right.tabState.draft).toBe('edited');
        expect(merged.details).toBe(source.details);
        expect(findSelectedPaneSlot(merged, 'missing')).toBeNull();
    });
});
