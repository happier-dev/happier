import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { unsavedWorkspaceFilePaths, useDetailsTabUnsavedKeys } from './detailsTabChrome';
import type { DetailsTabState } from './detailsWorkspaceTypes';
import { applyOpenDetailsTab, applySetDetailsTabState, applySplitDetailsGroup, applyMoveDetailsTabToGroup, createEmptyPaneDetailsState } from './detailsWorkspaceReducer';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import type { PaneScopeState } from '@/components/appShell/panes/model/appPaneReducer';
import { storage } from '@/sync/domains/state/storage';

describe('Details unsaved tab chrome', () => {
    it('projects each dirty file from its captured root into the requested workspace', () => {
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'draft' };
        const tabs: DetailsTabState[] = ['/repo', '/repo/nested', '/repo-other'].map((rootPath, index) => ({
            key: `file-${index}`, kind: 'file', title: 'a.ts', resource: { path: 'a.ts', rootPath }, isPinned: true, isPreview: false,
        }));
        expect(unsavedWorkspaceFilePaths({ accountId: 'alice', rootPath: '/repo', details: {
            tabs, tabState: Object.fromEntries(tabs.map(tab => [tab.key, draft])),
        } })).toEqual(['a.ts', 'nested/a.ts']);
        let details = createEmptyPaneDetailsState();
        for (const tab of tabs) {
            details = applyOpenDetailsTab(details, { tab, openAs: 'pinned' });
            details = applySetDetailsTabState(details, tab.key, draft);
        }
        const workspaceScope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        const pane: PaneScopeState = { details, mainHidden: false,
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} } };
        expect(unsavedWorkspaceFilePaths({ accountId: 'alice', workspaceScope,
            paneScopes: { [buildProjectPaneScopeId('project', 'home')]: pane },
            workspaceRefs: [{ ...workspaceScope, id: 'project', label: 'Project', createdAtMs: 1 }],
            sessionState: storage.getState(),
        })).toEqual(['a.ts', 'nested/a.ts']);
    });

    it('lists persisted drafts for inactive, unmounted and other-group file tabs while checking Account ownership', () => {
        const tab = (key: string): DetailsTabState => ({ key, kind: 'file', title: key, resource: { path: `/repo/${key}.ts` }, isPinned: true, isPreview: false });
        const a = tab('a'); const b = tab('b'); const c = tab('c');
        const draft = { accountId: 'alice', isEditingFile: true, editorOriginalHash: 'base', editorText: 'draft' };
        let details = createEmptyPaneDetailsState();
        for (const opened of [a, b, c, tab('foreign')]) {
            details = applyOpenDetailsTab(details, { tab: opened, openAs: 'pinned' });
            details = applySetDetailsTabState(details, opened.key, opened.key === 'foreign' ? { ...draft, accountId: 'bob' } : draft);
        }
        details = applySetDetailsTabState(details, 'closed', draft);
        details = applySplitDetailsGroup(details, { axis: 'horizontal', groupId: 'group:1' });
        details = applyMoveDetailsTabToGroup(details, { tabKey: 'c', targetGroupId: 'group:2' });
        const pane: PaneScopeState = { details, mainHidden: false,
            right: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, selectedDestination: null, tabState: {} } };
        const workspaceScope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };
        const input = { accountId: 'alice', workspaceScope,
            paneScopes: { [buildProjectPaneScopeId('project', 'home', 'editor-instance')]: pane },
            workspaceRefs: [{ ...workspaceScope, id: 'project', label: 'Project', createdAtMs: 1 }], sessionState: storage.getState() };
        expect(unsavedWorkspaceFilePaths(input)).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(unsavedWorkspaceFilePaths({ ...input, accountId: null })).toEqual([]);
        expect(unsavedWorkspaceFilePaths({ ...input, workspaceScope: { ...workspaceScope, machineId: 'different' } })).toEqual([]);
        expect(unsavedWorkspaceFilePaths({ ...input, workspaceScope: { ...workspaceScope, serverId: 'other-home' } })).toEqual([]);
        expect(unsavedWorkspaceFilePaths({ ...input, workspaceScope: { ...workspaceScope, rootPath: '/repo-other' } })).toEqual([]);
    });
    it('pins a preview only when its unsaved state becomes true', async () => {
        const pinTab = vi.fn();
        const hook = await renderHook(() => useDetailsTabUnsavedKeys(pinTab));
        const chrome = hook.getCurrent().chromeFor('file:a');
        await act(async () => chrome.setUnsaved(true));
        expect(pinTab).toHaveBeenCalledWith('file:a', { persist: false });
        expect(hook.getCurrent().unsavedKeys.has('file:a')).toBe(true);
        await act(async () => chrome.setUnsaved(true));
        expect(pinTab).toHaveBeenCalledTimes(1);
        await act(async () => chrome.setUnsaved(false));
        expect(hook.getCurrent().unsavedKeys.size).toBe(0);
    });
});
