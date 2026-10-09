import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { useProjectSurfaceActions } from './useProjectSurfaceActions';

const boundary = vi.hoisted(() => ({ sequence: 10, push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push } }).module;
});
// The modal presentation is the boundary: on a computer Open is the dialog over the current page.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// IndexedDB is supplied by the canonical runtime harness; draft and pane owners stay real.
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(boundary.sequence++).padStart(12, '0')}` }));
function Wrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }
const runtime = installSessionPaneRuntimeTestHarness();

describe('useProjectSurfaceActions', () => {
    beforeEach(async () => {
        standardCleanup(); boundary.push.mockReset(); resetSessionDraftRepositoryForTests();
        await prepareSessionDraftPersistenceStorage();
    });
    it('retains an agent-free worktree draft with the exact Home, Machine and current folder before navigation', async () => {
        const hook = await renderHook(() => useProjectSurfaceActions({ scopeId: 'project:wr_1',
            workspaceRef: { id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo', createdAtMs: 1 },
            activeRootPath: '/repo/.worktrees/feature-auth' }), { wrapper: Wrapper });
        hook.getCurrent().openCreateWorktreeFlow();
        const { Modal } = await import('@/modal');
        const dialogParams = () => vi.mocked(Modal.show).mock.calls.map(([config]) => config as { chrome?: { testID?: string }; props?: { routeParams?: { draftId: string; serverId: string } } })
            .find(config => config.chrome?.testID === 'projects.open.dialog')?.props?.routeParams;
        await vi.waitFor(() => expect(dialogParams()).toBeDefined());
        expect(boundary.push).not.toHaveBeenCalled();
        const route = { params: dialogParams()! };
        const document = getSessionDraftSnapshot({ serverId: runtime.serverId, accountId: 'account-a' }, { kind: 'projectOpen', draftId: route.params.draftId })?.document;
        expect(document).toMatchObject({ target: { kind: 'projectOpen' }, selection: { value: {
            serverId: runtime.serverId, machineId: 'machine-1', source: { kind: 'folder', path: '/repo/.worktrees/feature-auth' },
            materialization: { kind: 'worktree', checkout: { kind: 'git_worktree', displayName: '', baseRef: null } },
        } } });
        expect(document).not.toHaveProperty('composer');
        await hook.unmount();
    });
});
