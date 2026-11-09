import { describe, expect, it } from 'vitest';
import { createWorkspaceState, reduceWorkspaceState, type WorkspaceTab } from './workspaceState';
import { collectWorkspaceTabIntents, projectWorkspaceSharedTabs, reconcileWorkspaceSyncedTabs } from './workspaceSyncedTabs';
import { parseWorkspaceLayout, serializeWorkspaceLayout } from './workspacePersistence';

const sessionTab = (id: string, serverId = 'home-a'): WorkspaceTab => ({
    id, target: { kind: 'session', params: { id, serverId } }, pinned: false, preview: false,
});

describe('workspace window placement', () => {
    it('moves only local presentation among 1,000 tabs, preserving membership and publishing zero shared edits', () => {
        let state = createWorkspaceState(sessionTab('selected'));
        for (let i = 0; i < 999; i++) state = reduceWorkspaceState(state, {
            type: 'openTab', groupId: 'group:1', tab: sessionTab(`sibling-${i}`, i % 2 ? 'home-b' : 'home-a'),
        });
        const moved = reduceWorkspaceState(state, { type: 'setPresentation', tabId: 'selected', presentation: { windowId: 'window-a' } });
        expect(moved.tabs.selected.presentation).toEqual({ windowId: 'window-a' });
        expect(moved.groups['group:1'].tabIds).toBe(state.groups['group:1'].tabIds);
        for (let i = 0; i < 999; i++) expect(moved.tabs[`sibling-${i}`]).toBe(state.tabs[`sibling-${i}`]);
        expect(projectWorkspaceSharedTabs(moved)).toEqual(projectWorkspaceSharedTabs(state));
        expect(collectWorkspaceTabIntents(state, moved)).toEqual([]);
        expect(reduceWorkspaceState(moved, { type: 'setPresentation', tabId: 'selected', presentation: { windowId: 'window-a' } })).toBe(moved);
    });

    it('restores placement from local layout, retains it through shared reconciliation and returns without a delete', () => {
        const state = createWorkspaceState(sessionTab('selected'));
        const moved = reduceWorkspaceState(state, { type: 'setPresentation', tabId: 'selected', presentation: { windowId: 'window-a' } });
        const restored = parseWorkspaceLayout(JSON.parse(JSON.stringify(serializeWorkspaceLayout(moved))))!;
        expect(restored.tabs.selected.presentation).toEqual({ windowId: 'window-a' });
        const reconciled = reconcileWorkspaceSyncedTabs(restored, projectWorkspaceSharedTabs(state), () => 'empty');
        expect(reconciled.tabs.selected.presentation).toEqual({ windowId: 'window-a' });
        const returned = reduceWorkspaceState(reconciled, { type: 'setPresentation', tabId: 'selected', presentation: null });
        expect(returned.tabs.selected.presentation).toBeUndefined();
        expect(returned.groups['group:1'].tabIds).toEqual(['selected']);
        expect(collectWorkspaceTabIntents(reconciled, returned)).toEqual([]);
    });
});
