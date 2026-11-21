import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { registerMountedWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerReplace = vi.hoisted(() => vi.fn());
const viewport = vi.hoisted(() => ({ device: 'phone' as 'phone' | 'desktop' }));
const route = vi.hoisted(() => ({ pathname: '/projects/wr_1/overview' }));
function Wrapper(props: React.PropsWithChildren) { return React.createElement(AppPaneProvider, null, props.children); }

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => route.pathname, router: { replace: routerReplace },
}).module);

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useDeviceType: () => viewport.device,
    getDeviceType: () => viewport.device,
}));

let workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

const { storage } = await import('@/sync/domains/state/storageStore');
let unregisterWorkspace: (() => void) | undefined;
function mountWorkspace() {
    let state = createWorkspaceState({ id: 'project', target: { kind: 'project', params: {
        workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId,
    } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false,
        inbox: true, workflows: false, friends: false } });
    let nextId = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `project:${++nextId}`,
        onChange: () => {},
        // Browser history is the boundary; Action admission and workspace navigation stay real.
        transport: { commit: (href, _entry, replace) => {
            route.pathname = new URL(href, 'https://project.test').pathname;
            if (replace) routerReplace(href);
        } },
    });
    navigation.initialize(`${route.pathname}?serverId=${workspaceRef.serverId}`);
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
        createId: () => `project:${++nextId}` });
    unregisterWorkspace = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
}

describe('useProjectSurfaceController', () => {
    beforeEach(async () => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Project surfaces', accountId: 'alice', serverUrl: 'https://project-surfaces.test' });
        workspaceRef = { ...workspaceRef, serverId };
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, version);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        routerReplace.mockClear();
        viewport.device = 'phone';
        route.pathname = '/projects/wr_1/overview';
    });
    afterEach(() => {
        unregisterWorkspace?.(); unregisterWorkspace = undefined;
        standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false);
    });

    it.each(['phone', 'desktop'] as const)('keeps New in the %s route host and does not steal explicit dock moves on rerender', async device => {
        viewport.device = device;
        route.pathname = '/projects/wr_1/terminal';
        const { useProjectRouteSurfaceSync } = await import('./useProjectRouteSurfaceSync');
        let focused = true;
        const scopeId = `terminal-route-${device}`;
        const hook = await renderHook(() => {
            // Terminal is a phone page; the desktop route keeps Overview with its Terminal companion.
            useProjectRouteSurfaceSync({ scopeId, workspaceRef, activeRootPath: '/repo', isFocused: focused,
                surface: device === 'phone' ? 'terminal' : 'overview' });
            return useAppPaneContext();
        }, { wrapper: Wrapper });
        if (device === 'desktop') {
            await act(async () => hook.getCurrent().dispatch({ type: 'openRight', scopeId, tabId: 'terminal' }));
        }
        await act(async () => hook.getCurrent().dispatch({ type: 'terminalWorkspace', scopeId,
            command: { type: 'open', terminal: { id: 'route-shell', target: { kind: 'workspace_shell' } } } }));
        expect(hook.getCurrent().state.scopes[scopeId].bottom.isOpen).toBe(false);
        expect(hook.getCurrent().state.scopes[scopeId].right.isOpen).toBe(device === 'desktop');
        await act(async () => hook.getCurrent().dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' }));
        await hook.rerender();
        expect(hook.getCurrent().state.scopes[scopeId].bottom.isOpen).toBe(true);
        focused = false;
        await hook.rerender();
        focused = true;
        await hook.rerender();
        expect(hook.getCurrent().state.scopes[scopeId].bottom.isOpen).toBe(device === 'desktop');
        await hook.unmount();
    });

    it('preserves a non-worktree active root path when changing cockpit surfaces on phone', async () => {
        mountWorkspace();
        const { useProjectSurfaceController } = await import('./useProjectSurfaceController');
        const hook = await renderHook(() => ({ controller: useProjectSurfaceController({
            scopeId: 'project:wr_1',
            workspaceRef,
            activeRootPath: '/repo/packages/ui',
            activeWorktreeId: null,
        }), pane: useAppPaneScope('project:wr_1') }), { wrapper: Wrapper });

        const setActiveTab = hook.getCurrent().controller.setActiveTab;
        await act(async () => hook.getCurrent().pane.openDetailsTab({ key: 'file:src/current.ts', kind: 'file', title: 'current.ts',
            resource: { kind: 'file', path: 'src/current.ts' } }, { intent: 'pinned', present: false }));
        await act(async () => setActiveTab('services'));
        // A phone shows the tab as its page; the side pane never opens over it.
        expect(hook.getCurrent().pane.scopeState?.right).toMatchObject({ isOpen: false, activeTabId: 'services' });

        await vi.waitFor(() => expect(routerReplace).toHaveBeenCalled());
        const href = routerReplace.mock.lastCall?.[0];
        expect(typeof href).toBe('string');
        const route = new URL(href, 'https://project.test');
        // Services has its own page, so the tab opens it rather than a companion over Overview.
        expect(route.pathname).toBe('/projects/wr_1/services');
        expect(Object.fromEntries(route.searchParams)).toMatchObject({ activeRootPath: '/repo/packages/ui', serverId: workspaceRef.serverId,
            initialFile: 'src/current.ts' });

        await hook.unmount();
    });

    it('shows a companion page on a phone without opening the side pane over it', async () => {
        const { useProjectRouteSurfaceSync } = await import('./useProjectRouteSurfaceSync');
        const hook = await renderHook(() => {
            useProjectRouteSurfaceSync({ scopeId: 'project:wr_1', workspaceRef, activeRootPath: '/repo', isFocused: true, surface: 'terminal' });
            return useAppPaneScope('project:wr_1');
        }, { wrapper: Wrapper });

        expect(hook.getCurrent().scopeState?.right).toMatchObject({ isOpen: false, activeTabId: 'terminal' });
        await hook.unmount();
    });

    it('keeps Code History selected after navigating to Changes and synchronizing its surface', async () => {
        viewport.device = 'desktop';
        route.pathname = '/projects/wr_1/code';
        mountWorkspace();
        const { useProjectSurfaceController } = await import('./useProjectSurfaceController');
        const { useProjectRouteSurfaceSync } = await import('./useProjectRouteSurfaceSync');
        const hook = await renderHook(() => {
            const controller = useProjectSurfaceController({ scopeId: 'project:wr_1', workspaceRef, activeRootPath: '/repo' });
            useProjectRouteSurfaceSync({ scopeId: 'project:wr_1', workspaceRef, activeRootPath: '/repo',
                isFocused: true, surface: controller.page });
            const pane = useAppPaneScope('project:wr_1');
            return { controller, pane, scm: useWorkspaceScmTabState(pane) };
        }, { wrapper: Wrapper });

        await act(async () => hook.getCurrent().controller.openCodeHistory({ kind: 'folder', path: '' }));
        await vi.waitFor(() => expect(route.pathname).toBe('/projects/wr_1/changes'));
        await hook.rerender();
        await flushHookEffects();

        expect(hook.getCurrent().controller.page).toBe('changes');
        expect(hook.getCurrent().scm.activeGitSubTab).toBe('history');
        await hook.unmount();
    });

    it('keeps Code navigation in the accepted guest cache instead of another guest at the same path', async () => {
        const { useProjectSurfaceController } = await import('./useProjectSurfaceController');
        const { useRepositoryTreeBrowserState } = await import('@/hooks/workspaces/files/repositoryTreeBrowserState');
        const { buildWorkspaceCacheKey, workspaceScopeFromProject } = await import('@/sync/domains/workspaces/workspaceScope');
        const managed = (id: string): WorkspaceRefV1 => ({ v: 2, kind: 'managed', id,
            serverId: workspaceRef.serverId, managedId: id,
            controller: { machineId: 'machine-1', installationId: 'installation' },
            rootPath: '/repo', createdAtMs: 1 });
        const guest = managed('guest-code-a');
        const other = managed('guest-code-b');
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [guest, other] });
        route.pathname = `/projects/${guest.id}/code`;
        const hook = await renderHook(() => ({
            controller: useProjectSurfaceController({ scopeId: 'managed-code-cache', workspaceRef: guest, activeRootPath: '/repo' }),
            guest: useRepositoryTreeBrowserState(buildWorkspaceCacheKey(workspaceScopeFromProject(guest, '/repo'))),
            other: useRepositoryTreeBrowserState(buildWorkspaceCacheKey(workspaceScopeFromProject(other, '/repo'))),
        }), { wrapper: Wrapper });
        await act(async () => hook.getCurrent().guest.setLocation({ kind: 'folder', path: 'guest-before-route' }));
        await act(async () => hook.getCurrent().other.setLocation({ kind: 'folder', path: 'other-retained' }));
        await hook.unmount();
        const remounted = await renderHook(() => ({
            controller: useProjectSurfaceController({ scopeId: 'managed-code-cache', workspaceRef: guest, activeRootPath: '/repo' }),
            guest: useRepositoryTreeBrowserState(buildWorkspaceCacheKey(workspaceScopeFromProject(guest, '/repo'))),
            other: useRepositoryTreeBrowserState(buildWorkspaceCacheKey(workspaceScopeFromProject(other, '/repo'))),
        }), { wrapper: Wrapper });
        expect(remounted.getCurrent().guest.location).toEqual({ kind: 'folder', path: '' });
        expect(remounted.getCurrent().other.location).toEqual({ kind: 'folder', path: 'other-retained' });
        expect(remounted.getCurrent().controller.checkoutWorkspace).toMatchObject({ kind: 'managed', managedId: guest.id });
        await remounted.unmount();
    });

    it('keeps the selected Scripts page when a retained Git companion folds away on phone', async () => {
        viewport.device = 'desktop';
        route.pathname = '/projects/wr_1/scripts';
        mountWorkspace();
        const { useProjectRouteSurfaceSync } = await import('./useProjectRouteSurfaceSync');
        const hook = await renderHook(() => {
            useProjectRouteSurfaceSync({ scopeId: 'project:wr_1', workspaceRef, activeRootPath: '/repo', isFocused: true, surface: 'scripts' });
            return useAppPaneScope('project:wr_1');
        }, { wrapper: Wrapper });

        await act(async () => hook.getCurrent().openRight({ tabId: 'git' }));
        expect(hook.getCurrent().scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'git' });
        viewport.device = 'phone';
        await hook.rerender();
        await flushHookEffects({ cycles: 30 });

        expect(hook.getCurrent().scopeState?.right).toMatchObject({ isOpen: false, activeTabId: 'git' });
        expect(routerReplace).not.toHaveBeenCalled();
        expect(route.pathname).toBe('/projects/wr_1/scripts');
        await hook.unmount();
    });
});
