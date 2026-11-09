import { describe, expect, it, vi } from 'vitest';

import { collectSplitCanvasLeafIds } from '../splitCanvas/model/splitCanvasSelectors';
import { createWorkspaceState, reduceWorkspaceState, selectWorkspaceVisibleGroup } from './workspaceState';
import type { WorkspaceTab } from './workspaceState';
import { parseWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey } from './workspacePersistence';

const tab = (id: string, kind = 'session', preview = false): WorkspaceTab => {
    const params: Record<string, string> = kind === 'session' ? { id, serverId: 'home-a' } : {};
    return { id, target: { kind, params }, pinned: !preview, preview };
};

describe('workspace state', () => {
    it('presents the remaining MRU tab while window placements and admitted transfers retain their membership', () => {
        let state = createWorkspaceState(tab('remaining'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('placed') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('transferring') });
        const original = state.groups['group:1'];
        expect(selectWorkspaceVisibleGroup(state, original)).toBe(original);
        state = reduceWorkspaceState(state, { type: 'setPresentation', tabId: 'placed', presentation: { windowId: 'native-window' } });
        expect(selectWorkspaceVisibleGroup(state, original, { transferringTabIds: ['transferring'] })).toEqual({
            id: 'group:1', tabIds: ['remaining'], activeTabId: 'remaining', mru: ['remaining'],
        });
        expect(state.groups['group:1']).toBe(original);
        expect(Object.keys(state.tabs)).toEqual(['remaining', 'placed', 'transferring']);
        expect(selectWorkspaceVisibleGroup(state, original, { transferringTabIds: ['transferring', 'remaining'] }).activeTabId).toBe('');
    });
    it('excludes scoped window records from other layouts but admits the destination own tab', () => {
        const state = createWorkspaceState(tab('same-id'));
        const group = state.groups['group:1'];
        const placedTabs = [{ tabId: 'same-id', windowId: 'destination', serverId: 'home-a', accountId: 'alice' }];
        const scope = { serverId: 'home-a', accountId: 'alice' };
        expect(selectWorkspaceVisibleGroup(state, group, { placedTabs, scope }).tabIds).toEqual([]);
        expect(selectWorkspaceVisibleGroup(state, group, { placedTabs, scope, windowId: 'destination' })).toBe(group);
        expect(selectWorkspaceVisibleGroup(state, group, { placedTabs, scope: { ...scope, serverId: 'other-home' } })).toBe(group);
        expect(selectWorkspaceVisibleGroup(state, group, { placedTabs, scope: { ...scope, accountId: 'bob' } })).toBe(group);
    });
    it('retires a saved title when a tab navigates to another destination', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'setFallbackTitle', tabId: 'a', title: 'Original session' });
        const navigated = reduceWorkspaceState(state, { type: 'setTarget', tabId: 'a', target: { kind: 'settings', params: { pageId: 'appearance' } } });
        expect(navigated.fallbackTitlesByTabId.a).toBeUndefined();
    });
    it('bulk closes unpinned members once, keeps the surviving MRU active and preserves original reopen positions', () => {
        let state = createWorkspaceState({ ...tab('pinned'), pinned: true });
        for (const id of ['left', 'active', 'right', 'survivor']) {
            state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { ...tab(id), pinned: false } });
        }
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'survivor' });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'active' });
        const closed = reduceWorkspaceState(state, { type: 'closeTabs', groupId: 'group:1', tabIds: ['right', 'active', 'left', 'pinned', 'missing'], newTab: { ...tab('blank', 'newTab'), pinned: false } });
        expect(closed.groups['group:1']).toMatchObject({ tabIds: ['pinned', 'survivor'], activeTabId: 'survivor', mru: ['survivor', 'pinned'] });
        expect(closed.tabs.pinned).toBe(state.tabs.pinned);
        expect(closed.recentlyClosed.map(entry => [entry.tab.id, entry.index])).toEqual([['right', 3], ['active', 2], ['left', 1]]);
        expect(reduceWorkspaceState(closed, { type: 'closeTabs', groupId: 'group:1', tabIds: ['pinned', 'missing'], newTab: tab('unused', 'newTab') })).toBe(closed);
    });

    it('drops tabs whose destination is known gone, but not the tab on screen or a pinned one (QA-PROJECTS D13)', async () => {
        const { selectWorkspaceTabsForGoneDestinations } = await import('./workspaceState');
        const project = (id: string, workspaceRefId: string, pinned = false): WorkspaceTab =>
            ({ id, target: { kind: 'project', params: { workspaceRefId } }, pinned, preview: false });
        let state = createWorkspaceState(project('gone-a', 'deleted-1'));
        for (const next of [project('alive', 'kept'), project('gone-b', 'deleted-2'), project('gone-pinned', 'deleted-3', true), project('gone-shown', 'deleted-4')]) {
            state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: next });
        }
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'gone-shown' });
        const gone = (target: WorkspaceTab['target']) => target.kind === 'project' && String(target.params.workspaceRefId).startsWith('deleted');
        expect(selectWorkspaceTabsForGoneDestinations(state, gone)).toEqual([{ groupId: 'group:1', tabIds: ['gone-a', 'gone-b'] }]);
        expect(selectWorkspaceTabsForGoneDestinations(state, () => false)).toEqual([]);
    });

    it('bulk closing the final pane leaves one empty tab and closing a split pane restores focus to its sibling', () => {
        let state = createWorkspaceState({ ...tab('a'), pinned: false });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: { ...tab('b'), pinned: false } });
        const empty = { ...tab('blank', 'newTab'), pinned: false };
        const closed = reduceWorkspaceState(state, { type: 'closeTabs', groupId: 'group:1', tabIds: ['b', 'a', 'b'], newTab: empty });
        expect(closed.groups['group:1']).toMatchObject({ tabIds: ['blank'], activeTabId: 'blank' });
        expect(Object.keys(closed.tabs)).toEqual(['blank']);
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const sibling = reduceWorkspaceState(state, { type: 'closeTabs', groupId: 'group:2', tabIds: ['b'], newTab: empty });
        expect(Object.keys(sibling.groups)).toEqual(['group:1']);
        expect(sibling.focusedGroupId).toBe('group:1');
        expect(sibling.groups['group:1'].activeTabId).toBe('a');
    });

    it('opens a destination edge in one transition and leaves all state untouched if measured admission fails', () => {
        const state = createWorkspaceState(tab('current', 'session', true));
        const action = { type: 'openSplitTab' as const, groupId: 'group:1', tab: tab('incoming'),
            newGroupId: 'group:2', axis: 'row' as const, placement: 'after' as const,
            availableSizePx: 1200, minimumFirstSizePx: 420, minimumSecondSizePx: 420 };
        const refused = reduceWorkspaceState(state, { ...action, availableSizePx: 500 });
        expect(refused).toBe(state);
        const opened = reduceWorkspaceState(state, action);
        expect(opened.groups['group:1'].tabIds).toEqual(['current']);
        expect(opened.groups['group:2'].tabIds).toEqual(['incoming']);
        expect(opened.tabs.current).toBe(state.tabs.current);
        expect(opened.focusedGroupId).toBe('group:2');
    });

    it('keeps both preview contents when an existing tab is moved into another pane', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('moving', 'session', true) });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:2', tab: tab('current', 'session', true) });
        const moved = reduceWorkspaceState(state, { type: 'moveTab', tabId: 'moving', sourceGroupId: 'group:1', targetGroupId: 'group:2', beforeTabId: 'current' });
        expect(moved.groups['group:2'].tabIds).toEqual(['b', 'moving', 'current']);
        expect(moved.tabs.current).toBe(state.tabs.current);
        expect(moved.tabs.moving.preview).toBe(false);
    });

    it('opens and moves against current before-tab membership without replacing kept tabs', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('late'), beforeTabId: 'b' });
        expect(state.groups['group:1'].tabIds).toEqual(['a', 'late', 'b']);
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1200, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        state = reduceWorkspaceState(state, { type: 'moveTab', tabId: 'late', sourceGroupId: 'group:1', targetGroupId: 'group:2', beforeTabId: 'b' });
        expect(state.groups['group:2'].tabIds).toEqual(['late', 'b']);
        expect(state.groups['group:1'].tabIds).toEqual(['a']);
        const reordered = reduceWorkspaceState(state, { type: 'reorderTab', groupId: 'group:2', tabId: 'late', beforeTabId: 'deleted' });
        expect(reordered.groups['group:2'].tabIds).toEqual(['b', 'late']);
        expect(reordered.tabs.b).toBe(state.tabs.b);
    });

    it('keeps explicitly closed tabs available to reopen throughout the window lifetime', () => {
        let state = createWorkspaceState(tab('a'));
        for (let index = 0; index < 25; index++) {
            const nextTab = tab(`closed:${index}`);
            state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: nextTab });
            state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: nextTab.id, newTab: tab('blank', 'newTab') });
        }
        expect(state.recentlyClosed).toHaveLength(25);
        expect(state.recentlyClosed[0].tab.id).toBe('closed:24');
        const reopened = reduceWorkspaceState(state, { type: 'reopenTab', tabId: 'closed:0' });
        expect(reopened.tabs['closed:0']).toBeDefined();
        expect(reopened.recentlyClosed).toHaveLength(24);
    });
    it('reopens an explicitly closed preview as a kept tab at its former position without replacing the current preview', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('closed', 'session', true), fallbackTitle: 'Saved title' });
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'closed', newTab: tab('blank', 'newTab') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('current', 'settings', true) });
        const reopened = reduceWorkspaceState(state, { type: 'reopenTab' });
        expect(reopened.groups['group:1'].tabIds).toEqual(['a', 'closed', 'current']);
        expect(reopened.groups['group:1'].activeTabId).toBe('closed');
        expect(reopened.tabs.closed).toMatchObject({ pinned: false, preview: false });
        expect(reopened.tabs.current).toBe(state.tabs.current);
        expect(reopened.fallbackTitlesByTabId.closed).toBe('Saved title');
        expect(reopened.recentlyClosed).toEqual([]);
        expect(reduceWorkspaceState(reopened, { type: 'reopenTab' })).toBe(reopened);
    });

    it('restores a closed pane in place while preserving changes in the surviving pane', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1', newGroupId: 'group:2', axis: 'row', placement: 'after', availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        const root = state.root;
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:2', tabId: 'b', newTab: tab('blank', 'newTab') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('new') });
        const reopened = reduceWorkspaceState(state, { type: 'reopenTab' });
        expect(reopened.root).toEqual(root);
        expect(reopened.groups['group:1'].tabIds).toEqual(['a', 'new']);
        expect(reopened.groups['group:2'].tabIds).toEqual(['b']);
        expect(reopened.focusedGroupId).toBe('group:2');
        expect(reopened.tabPairs).toEqual([['new', 'b']]);
        expect(parseWorkspaceLayout(serializeWorkspaceLayout(reopened))).toEqual(reopened);
    });

    it('keeps closed-tab history local to this window lifetime, excluding remote closes and replaced previews', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('preview', 'session', true) });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('replacement', 'session', true) });
        expect(state.recentlyClosed).toEqual([]);
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'a', newTab: tab('blank', 'newTab'), remember: false });
        expect(state.recentlyClosed).toEqual([]);
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'replacement', newTab: tab('blank', 'newTab') });
        expect(state.recentlyClosed.map(entry => entry.tab.id)).toEqual(['replacement']);
        expect(serializeWorkspaceLayout(state)).not.toHaveProperty('recentlyClosed');
        expect(parseWorkspaceLayout(serializeWorkspaceLayout(state))?.recentlyClosed).toEqual([]);
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'blank', newTab: tab('next-blank', 'newTab') });
        expect(state.recentlyClosed.map(entry => entry.tab.id)).toEqual(['replacement']);
    });

    it('keeps portable split membership across focus, local restore and closing one member', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, {
            type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        expect(state.tabPairs).toEqual([['a', 'b']]);
        const membership = state.tabPairs;
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c') });
        expect(state.tabPairs).toBe(membership);
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'a' });
        expect(state.tabPairs).toBe(membership);
        const restored = parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(state))))!;
        expect(restored.tabPairs).toEqual([['a', 'b']]);
        const closed = reduceWorkspaceState(restored, { type: 'closeTab', groupId: 'group:2', tabId: 'b',
            newTab: { id: 'blank', target: { kind: 'newTab', params: {} }, pinned: false, preview: false } });
        expect(closed.tabPairs).toEqual([]);
    });
    it('promotes a preview to an intentional tab without pinning it or disturbing its group', () => {
        const state = createWorkspaceState(tab('preview', 'session', true));
        const promoted = reduceWorkspaceState(state, { type: 'promoteTab', tabId: 'preview' });
        expect(promoted.tabs.preview).toMatchObject({ id: 'preview', pinned: false, preview: false });
        expect(promoted.groups).toBe(state.groups);
        expect(promoted.root).toBe(state.root);
        expect(reduceWorkspaceState(promoted, { type: 'promoteTab', tabId: 'preview' })).toBe(promoted);
        expect(reduceWorkspaceState(promoted, { type: 'promoteTab', tabId: 'missing' })).toBe(promoted);
    });

    it('unpins an intentional tab without replacing the preview or changing the focused destination', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('preview', 'settings', true) });
        const group = state.groups['group:1'];
        const unpinned = reduceWorkspaceState(state, { type: 'setPinned', tabId: 'a', pinned: false });
        expect(unpinned.tabs.a).toMatchObject({ pinned: false, preview: false });
        expect(unpinned.tabs.preview).toBe(state.tabs.preview);
        expect(unpinned.groups['group:1']).toBe(group);
        expect(reduceWorkspaceState(unpinned, { type: 'setPinned', tabId: 'a', pinned: false })).toBe(unpinned);
        const promoted = reduceWorkspaceState(unpinned, { type: 'setPinned', tabId: 'preview', pinned: true });
        expect(promoted.tabs.preview).toMatchObject({ pinned: true, preview: false });
        expect(promoted.groups['group:1']).toBe(group);
    });

    it('reorders a tab without changing focus, recency, pinning or preview disposition', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c', 'settings', true) });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'b' });
        const before = state;
        const reordered = reduceWorkspaceState(state, { type: 'reorderTab', groupId: 'group:1', tabId: 'c', index: 0 });
        expect(reordered.groups['group:1'].tabIds).toEqual(['c', 'a', 'b']);
        expect(reordered.groups['group:1'].activeTabId).toBe('b');
        expect(reordered.groups['group:1'].mru).toBe(before.groups['group:1'].mru);
        expect(reordered.tabs).toBe(before.tabs);
        expect(reordered.root).toBe(before.root);
        expect(reordered.focusedGroupId).toBe(before.focusedGroupId);
        expect(parseWorkspaceLayout(serializeWorkspaceLayout(reordered))).toEqual(reordered);
        expect(reduceWorkspaceState(reordered, { type: 'reorderTab', groupId: 'group:1', tabId: 'c', index: 0 })).toBe(reordered);
        for (const index of [-1, 3, 0.5]) {
            expect(reduceWorkspaceState(reordered, { type: 'reorderTab', groupId: 'group:1', tabId: 'c', index })).toBe(reordered);
        }
        expect(reduceWorkspaceState(reordered, { type: 'reorderTab', groupId: 'missing', tabId: 'c', index: 0 })).toBe(reordered);
        expect(reduceWorkspaceState(reordered, { type: 'reorderTab', groupId: 'group:1', tabId: 'missing', index: 0 })).toBe(reordered);
        expect(reduceWorkspaceState(reordered, { type: 'reorderTab', groupId: 'group:1', tabId: 'c', index: 2 }).groups['group:1'].tabIds).toEqual(['a', 'b', 'c']);
    });

    it('splits a saved layout after reload without reusing a divider identity', async () => {
        let saved = createWorkspaceState(tab('a'));
        saved = reduceWorkspaceState(saved, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        saved = reduceWorkspaceState(saved, {
            type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        // A persisted identity survives a fresh geometry module, unlike its process counter.
        saved = { ...saved, root: { ...saved.root!, id: 'split:1' } };
        vi.resetModules();
        const { reduceWorkspaceState: reduceReloaded } = await import('./workspaceState');
        let restored = parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(saved))))!;
        expect(restored).not.toBeNull();
        restored = reduceReloaded(restored, { type: 'openTab', groupId: 'group:2', tab: tab('c') });
        restored = reduceReloaded(restored, {
            type: 'splitTab', tabId: 'c', sourceGroupId: 'group:2', targetGroupId: 'group:2',
            newGroupId: 'group:3', axis: 'column', placement: 'after',
            availableSizePx: 900, minimumFirstSizePx: 260, minimumSecondSizePx: 260,
        });
        if (restored.root?.kind !== 'split' || restored.root.second.kind !== 'split') throw new Error('Expected nested split');
        const nestedId = restored.root.second.id;
        expect(nestedId).not.toBe(restored.root.id);
        restored = reduceReloaded(restored, { type: 'resize', splitId: nestedId, ratio: 0.6,
            availableSizePx: 900, minimumFirstSizePx: 260, minimumSecondSizePx: 260 });
        restored = reduceReloaded(restored, { type: 'resize', splitId: 'split:1', ratio: 0.65,
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320 });
        expect(restored.root).toMatchObject({ id: 'split:1', ratio: 0.65, second: { id: nestedId, ratio: 0.6 } });
        expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(restored))))).toEqual(restored);
    });

    it('shows the restored group when activation changes focus from a maximized group', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, {
            type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        state = reduceWorkspaceState(state, { type: 'toggleMaximize', groupId: 'group:2' });
        const restored = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'a' });
        expect(restored.focusedGroupId).toBe('group:1');
        expect(restored.groups['group:1']?.activeTabId).toBe('a');
        expect(restored.maximizedGroupId).toBeNull();
    });

    it('splits a tab into nested real canvas groups, moves it, resizes, collapses and restores', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, {
            type: 'splitTab', tabId: 'b', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after',
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:2', tab: tab('c') });
        state = reduceWorkspaceState(state, {
            type: 'splitTab', tabId: 'c', sourceGroupId: 'group:2', targetGroupId: 'group:2',
            newGroupId: 'group:3', axis: 'column', placement: 'after',
            availableSizePx: 900, minimumFirstSizePx: 260, minimumSecondSizePx: 260,
        });
        expect(collectSplitCanvasLeafIds({ root: state.root })).toEqual(['group:1', 'group:2', 'group:3']);

        const splitId = state.root?.id;
        state = reduceWorkspaceState(state, {
            type: 'resize', splitId: splitId!, ratio: 0.6,
            availableSizePx: 1000, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        state = reduceWorkspaceState(state, { type: 'moveTab', tabId: 'b', sourceGroupId: 'group:2', targetGroupId: 'group:3' });
        expect(state.groups['group:2']).toBeUndefined();
        expect(state.groups['group:3']?.tabIds).toEqual(['c', 'b']);
        expect(state.root).toMatchObject({ kind: 'split', ratio: 0.6 });

        state = reduceWorkspaceState(state, { type: 'closeTab', tabId: 'b', groupId: 'group:3', newTab: tab('new', 'newTab') });
        const restored = parseWorkspaceLayout(serializeWorkspaceLayout(state));
        expect(restored).toEqual({ ...state, recentlyClosed: [] });
        expect(restored?.groups['group:3']?.activeTabId).toBe('c');
    });

    it('replaces only the focused group preview, uses MRU on close, and keeps unknown targets after restore', () => {
        let state = createWorkspaceState(tab('a'));
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('b') });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('c') });
        state = reduceWorkspaceState(state, { type: 'activateTab', groupId: 'group:1', tabId: 'b' });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('missing', 'removed:plugin', true), fallbackTitle: 'Old plugin page' });
        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('preview', 'settings', true) });
        expect(state.tabs.missing).toBeUndefined();
        expect(state.groups['group:1']?.tabIds).toEqual(['a', 'b', 'c', 'preview']);
        state = reduceWorkspaceState(state, { type: 'closeTab', groupId: 'group:1', tabId: 'preview', newTab: tab('new', 'newTab') });
        expect(state.groups['group:1']?.activeTabId).toBe('b');

        state = reduceWorkspaceState(state, { type: 'openTab', groupId: 'group:1', tab: tab('missing', 'removed:plugin', true), fallbackTitle: 'Old plugin page' });
        const restored = parseWorkspaceLayout(serializeWorkspaceLayout(state));
        expect(restored?.tabs.missing?.target.kind).toBe('removed:plugin');
        expect(restored?.fallbackTitlesByTabId.missing).toBe('Old plugin page');
    });

    it('rejects malformed membership and tree references instead of restoring a partial layout', () => {
        const snapshot = serializeWorkspaceLayout(createWorkspaceState(tab('a')));
        expect(parseWorkspaceLayout({ ...snapshot, groups: { 'group:1': { ...snapshot.groups['group:1'], tabIds: ['missing'] } } })).toBeNull();
        expect(parseWorkspaceLayout({ ...snapshot, root: { kind: 'leaf', id: 'wrong', leafKind: 'workspace-group', payload: { groupId: 'wrong' } } })).toBeNull();
        expect(parseWorkspaceLayout({ ...snapshot, tabPairs: null })).toBeNull();
        expect(parseWorkspaceLayout({ ...snapshot, tabPairs: undefined })).toBeNull();
        expect(parseWorkspaceLayout({ ...snapshot, tabPairs: [['a', 'missing']] })).toBeNull();
    });

    it('refuses an undersized split and turns the last closed tab into a new-tab target', () => {
        const initial = createWorkspaceState(tab('a'));
        const refused = reduceWorkspaceState(initial, {
            type: 'splitTab', tabId: 'a', sourceGroupId: 'group:1', targetGroupId: 'group:1',
            newGroupId: 'group:2', axis: 'row', placement: 'after', newTabForSource: tab('source-new', 'newTab'),
            availableSizePx: 500, minimumFirstSizePx: 320, minimumSecondSizePx: 320,
        });
        expect(refused).toBe(initial);

        const closed = reduceWorkspaceState(initial, { type: 'closeTab', groupId: 'group:1', tabId: 'a', newTab: tab('new', 'newTab') });
        expect(closed.groups['group:1']?.tabIds).toEqual(['new']);
        expect(closed.tabs.a).toBeUndefined();
        expect(closed.tabs.new?.target.kind).toBe('newTab');
    });

    it('keeps each account and window layout isolated and treats a damaged snapshot as empty', () => {
        const one = workspaceLayoutScopeKey({ serverId: 'home', accountId: 'alice', windowId: 'window-a' });
        const two = workspaceLayoutScopeKey({ serverId: 'home', accountId: 'alice', windowId: 'window-b' });
        const otherAccount = workspaceLayoutScopeKey({ serverId: 'home', accountId: 'bob', windowId: 'window-a' });
        const state = createWorkspaceState(tab('a'));
        const layouts = { [one]: serializeWorkspaceLayout(state) };
        expect(parseWorkspaceLayout(layouts[one])).toEqual(state);
        expect(parseWorkspaceLayout(layouts[two])).toBeNull();
        expect(parseWorkspaceLayout(layouts[otherAccount])).toBeNull();
        expect(parseWorkspaceLayout({ v: 1, tabs: {} })).toBeNull();
    });
});
