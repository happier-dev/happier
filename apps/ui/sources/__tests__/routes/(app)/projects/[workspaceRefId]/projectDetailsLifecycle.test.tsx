import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from '../../session/[id]/sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let phone = true;
let cockpit = false;
let workspaceAvailable = true;
let navigationCanGoBack = true;
const stackOptionsCapture = createStackOptionsCapture();
const router = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' }, navigation: { canGoBack: () => navigationCanGoBack },
    stackOptionsCapture,
});
installSessionRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { isPad: false },
        useWindowDimensions: () => ({ width: phone ? 390 : 1280, height: phone ? 844 : 900, scale: 1, fontScale: 1 }),
    }),
    router: () => router.module,
});
const snapshot: ScmWorkingSnapshot = {
    fetchedAt: 1, projectKey: 'machine-1:/repo',
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [],
        worktrees: [] },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    stashCount: 0, hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
};
function configureSocket(socket: import('socket.io-client').Socket) {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
        if (event !== 'rpc-call' || !payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Unexpected Socket RPC envelope');
        const method = payload.method.slice(payload.method.indexOf(':') + 1);
        return { ok: true, result: method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? { success: true, snapshot } : { success: false, errorCode: 'FEATURE_UNSUPPORTED' } };
    });
}
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1', configureSocket });

beforeEach(() => {
    phone = true; cockpit = false; workspaceAvailable = true; navigationCanGoBack = true;
    router.resetParams();
    stackOptionsCapture.reset();
    router.spies.push.mockClear(); router.spies.back.mockClear(); router.spies.replace.mockClear();
});
function workspaceRef() {
    return WorkspaceRefV1Schema.parse({
        id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1',
        rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1,
    });
}
type ProjectRoute = 'files' | 'git' | 'details' | 'terminal';
async function renderRoute(kind: ProjectRoute, withFile = false) {
    storage.getState().applySettingsLocal({
        mobileWorkspaceExperienceV1: cockpit ? 'cockpit' : 'classic',
        workspaceRefsV1: workspaceAvailable ? [workspaceRef()] : [],
    });
    storage.getState().applyMachines([createMachineFixture({ storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo' }, snapshot);
    const Screen = kind === 'files' ? (await import('@/app/(app)/projects/[workspaceRefId]/files')).default
        : kind === 'git' ? (await import('@/app/(app)/projects/[workspaceRefId]/git')).default
        : kind === 'details' ? (await import('@/app/(app)/projects/[workspaceRefId]/details')).default
        : (await import('@/app/(app)/projects/[workspaceRefId]/terminal')).default;
    const { createProjectFileDetailsTab } = await import('@/components/projects/detail/projectDetailsTabBuilders');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => {
        runtime.pane.openRight({ tabId: kind === 'files' ? 'files' : kind === 'terminal' ? 'terminal' : 'git' });
        if (withFile) runtime.pane.openDetailsTab(createProjectFileDetailsTab('/repo/a'), { intent: 'pinned' });
    });
    await screen.update(<runtime.Wrapper><Screen /></runtime.Wrapper>);
    return {
        screen, rerender: () => screen.update(<runtime.Wrapper><Screen /></runtime.Wrapper>),
        unmountRoute: () => screen.update(<runtime.Wrapper />),
    };
}

describe('project route details lifecycle', () => {
    it('pushes fullscreen details again when the actual selected tab changes', async () => {
        await renderRoute('files', true);
        expect(router.spies.push).toHaveBeenCalledTimes(1);
        expect(router.spies.push).toHaveBeenLastCalledWith('/projects/wr_1/details?worktreeId=%40root&sourceSurface=browse');
        const { createProjectFileDetailsTab } = await import('@/components/projects/detail/projectDetailsTabBuilders');
        await act(async () => runtime.pane.openDetailsTab(createProjectFileDetailsTab('/repo/b'), { intent: 'pinned' }));
        expect(router.spies.push).toHaveBeenCalledTimes(2);
        expect(router.spies.push).toHaveBeenLastCalledWith('/projects/wr_1/details?worktreeId=%40root&sourceSurface=browse');
    });

    it.each(['files', 'git'] as const)('keeps the %s cockpit route active with an opened details tab', async (kind) => {
        cockpit = true;
        await renderRoute(kind, true);
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        expect(router.spies.push).not.toHaveBeenCalled();
    });

    it.each(['files', 'git'] as const)('does not overwrite an explicit right-panel selection on the larger %s route', async (kind) => {
        phone = false;
        const route = await renderRoute(kind);
        await act(async () => runtime.pane.setRightTab('browser'));
        await route.rerender();
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'browser' });
    });

    it.each(['browser', 'services'])('selects the %s mobile surface from the actual Files route hint', async (surface) => {
        router.state.router.setParams({ mobileSurface: surface });
        await renderRoute('files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: surface });
    });

    it('pushes fullscreen details from the classic terminal route', async () => {
        await renderRoute('terminal', true);
        expect(router.spies.push).toHaveBeenCalledWith('/projects/wr_1/details?worktreeId=%40root&sourceSurface=terminal');
    });

    it.each(['files', 'git', 'details', 'terminal'] as const)('retains hook ordering as the %s route admits its actual Workspace ref', async (kind) => {
        workspaceAvailable = false;
        const route = await renderRoute(kind, true);
        await act(async () => storage.getState().applySettingsLocal({ workspaceRefsV1: [workspaceRef()] }));
        await expect(route.rerender()).resolves.toBeUndefined();
        expect(storage.getState().settings.workspaceRefsV1).toEqual([workspaceRef()]);
    });

    it('closes Details when its fullscreen route unmounts while the pane provider survives', async () => {
        const route = await renderRoute('details', true);
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        await route.unmountRoute();
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
    });

    it('preserves Details and its route through an ordinary rerender', async () => {
        const route = await renderRoute('details', true);
        router.spies.replace.mockClear(); router.spies.back.mockClear();
        await route.rerender();
        expect(runtime.pane.scopeState?.details).toMatchObject({ isOpen: true, activeTabKey: 'file:/repo/a' });
        expect(router.spies.replace).not.toHaveBeenCalled();
        expect(router.spies.back).not.toHaveBeenCalled();
    });

    it('replaces empty Details with the actual current non-details project route', async () => {
        navigationCanGoBack = false;
        await renderRoute('details');
        expect(router.spies.replace).toHaveBeenCalledWith('/projects/wr_1/git?worktreeId=%40root');
    });

    it('replaces empty Details instead of returning through unrelated browser history', async () => {
        navigationCanGoBack = true;
        await renderRoute('details');
        expect(router.spies.back).not.toHaveBeenCalled();
        expect(router.spies.replace).toHaveBeenCalledWith('/projects/wr_1/git?worktreeId=%40root');
    });

    it('uses the source surface as the direct Details header fallback', async () => {
        navigationCanGoBack = false;
        router.state.router.setParams({ sourceSurface: 'browser' });
        await renderRoute('details', true);
        const headerLeft = stackOptionsCapture.getResolved()?.headerLeft;
        if (typeof headerLeft !== 'function') throw new Error('Expected native Details back action');
        const button = headerLeft();
        if (!React.isValidElement(button)) throw new Error('Expected rendered native back action');
        const header = await renderScreen(<>{button}</>);
        await header.pressByTestIdAsync('project-mobile-header-back');
        expect(router.spies.back).not.toHaveBeenCalled();
        expect(router.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=%40root&mobileSurface=browser');
    });

    it('keeps explicitly requested worktree overview without details tabs', async () => {
        navigationCanGoBack = false;
        router.state.router.setParams({ showWorktrees: '1' });
        await renderRoute('details');
        expect(router.spies.replace).not.toHaveBeenCalled();
    });

    it('keeps the cockpit Details destination before any detail tab opens', async () => {
        navigationCanGoBack = false; cockpit = true;
        await renderRoute('details');
        expect(router.spies.replace).not.toHaveBeenCalled();
    });

    it('retains fullscreen Details when a focused split group is empty but another group has a resource', async () => {
        const route = await renderRoute('details', true);
        await act(async () => {
            if (!runtime.pane.splitDetailsGroup) throw new Error('Expected canonical split action');
            runtime.pane.splitDetailsGroup({ axis: 'horizontal' });
        });
        router.spies.back.mockClear(); router.spies.replace.mockClear();
        await route.rerender();
        expect(runtime.pane.scopeState?.details.tabs).toHaveLength(0);
        expect(runtime.pane.scopeState?.details.groups?.some((group) => group.tabs.length > 0)).toBe(true);
        expect(router.spies.back).not.toHaveBeenCalled();
        expect(router.spies.replace).not.toHaveBeenCalled();
    });

    it('renders the actual worktree overview panel for explicit overview mode', async () => {
        router.state.router.setParams({ showWorktrees: '1' });
        const { screen } = await renderRoute('details');
        const { ProjectDetailsMainPanel } = await import('@/components/projects/detail/ProjectDetailsMainPanel');
        expect(screen.findByType(ProjectDetailsMainPanel).props.forceOverviewMode).toBe(true);
    });
});
