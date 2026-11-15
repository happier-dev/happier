import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import * as React from 'react';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { act } from 'react-test-renderer';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { WorkspaceActionOutcome } from '@/components/appShell/workspace/workspaceActions';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// Expo navigation is the boundary; page and qualified route decisions remain real.
const routerMock = createExpoRouterMock({ pathname: '/projects/wr_1/context', params: {
    workspaceRefId: 'wr_1', serverId: 'server-1', layoutId: 'selected',
    comparisonId: 'comparison-a', initialFile: 'a.ts' } });
vi.mock('expo-router', () => routerMock.module);
const { storage } = await import('@/sync/domains/state/storageStore');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceActionAdapter, workspaceActionFailure } = await import('@/components/appShell/workspace/workspaceActions');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { clearActiveUnsavedChangesGuard, runGuardedNavigation, setActiveUnsavedChangesGuard } = await import('@/utils/navigation/runGuardedNavigation');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { DestinationInstanceContext } = await import('@/components/appShell/workspace/destinationInstanceContext');
let workspaceRef: WorkspaceRefV1 = { id: 'wr_1', serverId: 'server-1', machineId: 'machine-1',
    rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1, lastOpenedAtMs: null };
let unregister: (() => void) | undefined;
function ProjectDestination(props: React.PropsWithChildren) {
    return <DestinationInstanceContext.Provider value={{ tabId: 'project', focused: true, isFocused: () => true, visible: true,
        pathname: '/projects/wr_1/context', ref: { kind: 'project', params: { workspaceRefId: 'wr_1',
            serverId: workspaceRef.serverId, layoutId: 'selected', comparisonId: 'comparison-a', initialFile: 'a.ts' } },
        navigation: { push: routerMock.module.router.push, replace: routerMock.module.router.replace, back: routerMock.module.router.back },
    }}>{props.children}</DestinationInstanceContext.Provider>;
}
function mountWorkspace() {
    let state = createWorkspaceState({ id: 'project', target: { kind: 'project', params: {
        workspaceRefId: workspaceRef.id, serverId: workspaceRef.serverId, pageId: 'context',
    } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
    const hrefs: string[] = [];
    const replacements: boolean[] = [];
    let nextId = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `project:${++nextId}`,
        onChange: () => {}, transport: { commit: (href, _entry, replace) => { hrefs.push(href); replacements.push(replace); } } });
    navigation.initialize(`/projects/wr_1/context?serverId=${workspaceRef.serverId}`);
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => `project:${++nextId}` });
    unregister = registerMountedWorkspaceAction(async request => {
        let outcome: WorkspaceActionOutcome | Promise<WorkspaceActionOutcome> = workspaceActionFailure('workspace_navigation_cancelled');
        await runGuardedNavigation(() => { outcome = execute(request.actionId, request.input); });
        return await outcome;
    });
    return { hrefs, replacements, state: () => state };
}
// Install the Expo transport before loading the owner, outside the behavioral test deadline.
const { useProjectRouteActions } = await import('./useProjectRouteActions');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { ProjectHeaderActions } = await import('./ProjectHeaderActions');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
describe('project route actions', () => {
    beforeEach(async () => {
        await homes.reset();
        const serverId = await homes.addHome({ name: 'Project navigation', accountId: 'alice', serverUrl: 'https://project-navigation.test' });
        workspaceRef = { ...workspaceRef, serverId };
        routerMock.module.router.setParams({ serverId });
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope({ serverId, accountId: 'alice' }, settings, version);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
        routerMock.spies.push.mockClear(); routerMock.spies.replace.mockClear();
    });
    afterEach(() => { unregister?.(); unregister = undefined; clearActiveUnsavedChangesGuard(); standardCleanup(); publishAppliedActiveServerRuntimeAvailability(false); });
    it('opens the existing terminal dock through the public Project header without navigating away from the current page', async () => {
        const workspace = mountWorkspace();
        const runtime: { pane?: ReturnType<typeof useAppPaneScope> } = {};
        function Header() {
            const pane = useAppPaneScope('project-header');
            runtime.pane = pane;
            const actions = useProjectRouteActions({ workspaceRef, activeRootPath: '/repo/feature',
                activeWorktreeId: 'checkout-a', pane });
            return <ProjectHeaderActions testIdPrefix="project-header" showWorktreesButton={false}
                onOpenTerminal={() => actions.openTerminal({ exitOverview: true })} />;
        }
        const screen = await renderScreen(<ProjectDestination><AppPaneProvider><Header /></AppPaneProvider></ProjectDestination>);
        await screen.pressByTestIdAsync('project-header-open-terminal');
        expect(runtime.pane?.scopeState?.bottom).toMatchObject({ isOpen: true, activeTabId: 'terminal' });
        expect(workspace.hrefs).toEqual([]);
        expect(workspace.state().tabs.project.target.params.pageId).toBe('context');
        await screen.unmount();
    });
    it('refuses Project page and checkout navigation when workspace.tabs.open is disabled', async () => {
        const scope = { serverId: workspaceRef.serverId, accountId: 'alice' };
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: { 'workspace.tabs.open': { enabled: false } },
        }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope(scope, settings, version);
        homes.answer(scope.serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        const workspace = mountWorkspace();
        const before = workspace.state();
        const hook = await renderHook(() => useProjectRouteActions({ workspaceRef, activeRootPath: '/repo' }), { wrapper: ProjectDestination });
        await act(async () => {
            await hook.getCurrent().navigateToSegment({ segment: 'changes' });
            await hook.getCurrent().navigateToSegment({ workspaceRef: { ...workspaceRef, id: 'wr_2' } });
            await hook.getCurrent().navigateToSegment({ activeRootPath: '/repo/feature', activeWorktreeId: 'checkout-a', method: 'replace' });
        });
        expect(routerMock.spies.push).not.toHaveBeenCalled();
        expect(routerMock.spies.replace).not.toHaveBeenCalled();
        expect(workspace.hrefs).toEqual([]);
        expect(workspace.state()).toBe(before);
        await hook.unmount();
    });
    it('preserves the unsaved-editor navigation refusal and replace-history intent', async () => {
        const workspace = mountWorkspace();
        const hook = await renderHook(() => useProjectRouteActions({ workspaceRef, activeRootPath: '/repo' }), { wrapper: ProjectDestination });
        setActiveUnsavedChangesGuard({ isDirtyRef: { current: true }, requestDecision: async () => 'keepEditing', tag: 'project-navigation' });
        await act(async () => { await hook.getCurrent().navigateToSegment({ segment: 'changes', method: 'replace' }); });
        expect(workspace.hrefs).toEqual([]);
        expect(routerMock.spies.replace).not.toHaveBeenCalled();
        clearActiveUnsavedChangesGuard();
        await act(async () => { await hook.getCurrent().navigateToSegment({ segment: 'changes', method: 'replace' }); });
        expect(workspace.hrefs.at(-1)).toContain('/projects/wr_1/changes');
        expect(workspace.replacements.at(-1)).toBe(true);
        await hook.unmount();
    });
    it('changes pages without dropping qualified dashboard, comparison, and file intent', async () => {
        const workspace = mountWorkspace();
        const hook = await renderHook(() => useProjectRouteActions({ workspaceRef,
            activeRootPath: '/repo/feature', activeWorktreeId: 'checkout-a' }), { wrapper: ProjectDestination });
        await act(async () => { await hook.getCurrent().navigateToSegment({ segment: 'changes', method: 'push' }); });
        const href = workspace.hrefs[0];
        expect(typeof href).toBe('string');
        const url = new URL(String(href), 'https://happier.test');
        expect(url.pathname).toBe('/projects/wr_1/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: workspaceRef.serverId, layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'a.ts', worktreeId: 'checkout-a' });
        expect(workspace.state().tabs.project.target.params.pageId).toBe('changes');
        expect(Object.keys(workspace.state().tabs)).toEqual(['project']);
        await act(async () => { await hook.getCurrent().navigateToSegment({ workspaceRef: { ...workspaceRef, id: 'wr_2', rootPath: '/other/repo' } }); });
        const checkout = new URL(String(workspace.hrefs[1]), 'https://happier.test');
        expect(checkout.pathname).toBe('/projects/wr_2/context');
        expect(Object.fromEntries(checkout.searchParams)).toEqual({ serverId: workspaceRef.serverId, layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'a.ts', worktreeId: '@root' });
        await hook.unmount();
    });
});
