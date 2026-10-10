import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: () => null,
        useLocalSettingMutable: () => [null, vi.fn()],
        storage: { getState: () => ({ getWorkspaceRepositoryTreeExpandedPaths: () => [], setWorkspaceRepositoryTreeExpandedPaths: () => {} }) },
    });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workspaceRef = { id: 'wr', serverId: 'server', machineId: 'machine', rootPath: '/repo', label: 'Repo', createdAtMs: 1, lastOpenedAtMs: null };
const scopeId = 'project:wr';
function Wrapper({ children }: React.PropsWithChildren) { return <AppPaneProvider>{children}</AppPaneProvider>; }

describe('project file navigation', () => {
    it('opens Changes review in its companion without creating a separate Details tab', async () => {
        const hook = await renderHook(() => ({ pane: useAppPaneScope(scopeId),
            actions: useProjectSurfaceActions({ scopeId, workspaceRef, activeRootPath: '/repo' }),
        }), { wrapper: Wrapper });
        await act(async () => hook.getCurrent().actions.openReviewAllChanges());
        expect(hook.getCurrent().pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
        expect(hook.getCurrent().pane.scopeState?.details.tabs).toEqual([]);
        await hook.unmount();
    });
    it('reveals through Files pane state and retains the current details draft', async () => {
        const hook = await renderHook(() => ({
            pane: useAppPaneScope(scopeId),
            actions: useProjectSurfaceActions({ scopeId, workspaceRef, activeRootPath: '/repo' }),
        }), { wrapper: Wrapper });
        await act(async () => hook.getCurrent().pane.setDetailsTabState('file:src/a.ts', { editorText: 'unsaved' }));
        await act(async () => hook.getCurrent().actions.revealInFilesTree('src/a.ts'));
        expect(hook.getCurrent().pane.scopeState?.right.activeTabId).toBe('files');
        expect(hook.getCurrent().pane.scopeState?.right.tabState.files).toMatchObject({ revealRequest: { path: 'src/a.ts' } });
        expect(hook.getCurrent().pane.scopeState?.details.tabState['file:src/a.ts']).toEqual({ editorText: 'unsaved' });
        await act(async () => hook.getCurrent().pane.setRightTabState('git', { activeSubTabId: 'history', commitMessageDraft: 'keep me' }));
        await act(async () => hook.getCurrent().actions.openChanges());
        expect(hook.getCurrent().pane.scopeState?.right.activeTabId).toBe('git');
        expect(hook.getCurrent().pane.scopeState?.right.tabState.git).toMatchObject({ activeSubTabId: 'commit', commitMessageDraft: 'keep me' });
        expect(hook.getCurrent().pane.scopeState?.details.tabState['file:src/a.ts']).toEqual({ editorText: 'unsaved' });
        await hook.unmount();
    });
});
