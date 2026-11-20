import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { PAGE_COLUMN_MAX_WIDTH_PX } from '@/components/ui/layout/contentWidthMode';
import { settingsParse } from '@/sync/domains/settings/settings';
import { projectLastActiveRootPathState, projectLastActiveWorktreeIdState } from '@/sync/domains/state/navigationUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { paneUiState } from '@/sync/domains/state/filePaneUiState';
import { EMPTY_PERSISTED_PANE_SCOPE_STATE } from '@/components/appShell/panes/model/paneScopePersistenceSchema';
import { createWorkspaceActionAdapter, workspaceActionFailure } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { registerMountedWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import type { WorkspaceActionOutcome } from '@/components/appShell/workspace/workspaceActions';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installSessionDetailsPanelNonRnModuleMocks();
const viewport = vi.hoisted(() => ({ width: 1440, height: 900 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }) },
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
    });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const daemon = vi.hoisted(() => vi.fn());
// Only the addressed daemon transport is replaced; SCM selection, storage and pane lifecycle stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemon }));

const { storage } = await import('@/sync/domains/state/storage');
const { buildProjectPaneScopeId } = await import('./detail/projectPaneScope');
const { ProjectDetailScreen } = await import('./ProjectDetailScreen');
const { ProjectRightPanel } = await import('./detail/ProjectRightPanel');
const { ProjectCockpitShell } = await import('@/components/workspaceCockpit/project/ProjectCockpitShell');
const { ProjectShellHeaderHost } = await import('./shell/ProjectShellHeaderHost');
const { PageBottomBarSeatProvider } = await import('@/components/ui/layout/useFloatingChromeClearance');
const { ProjectOverviewWidgets } = await import('./detail/ProjectOverviewWidgets');
const { useProjectNewSessionAction } = await import('./useProjectNewSessionAction');
const { useProjectRouteActions } = await import('./detail/useProjectRouteActions');
const { useProjectInitialResource } = await import('./detail/useProjectInitialResource');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);

const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ serverId }) => buildProjectPaneScopeId('wr_1', serverId),
    request: async (url, init) => artifacts.handle(new URL(String(url)).pathname, init),
});
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { CurrentUiContextProvider } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const worktrees = [
    { id: 'gitwt_main', path: '/repo', branch: 'main', isCurrent: true, isMain: true },
    { id: 'gitwt_feature', path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
    { id: 'gitwt_persisted', path: '/repo/.worktrees/feature-persisted', branch: 'feature/persisted', isCurrent: false },
    { id: 'gitwt_hydrated', path: '/repo/.worktrees/feature-hydrated', branch: 'feature/hydrated', isCurrent: false },
];
const snapshot = ScmWorkingSnapshotSchema.parse({
    projectKey: 'machine-1:/repo', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees },
    capabilities: { readStatus: true, readDiffFile: true, readDiffCommit: true, readLog: true,
        writeInclude: false, writeExclude: false, writeCommit: false, writeDiscard: false,
        writeCommitPathSelection: false, writeCommitLineSelection: false, writeBackout: false,
        writeRemoteFetch: false, writeRemotePull: false, writeRemotePush: false, worktreeCreate: false,
        changeSetModel: 'index', supportedDiffAreas: ['pending'] },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
        includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
});
let workspaceRef: WorkspaceRefV1;
let unregisterWorkspace: (() => void) | undefined;
afterEach(() => { unregisterWorkspace?.(); unregisterWorkspace = undefined; });
beforeEach(async () => {
    viewport.width = 1440;
    viewport.height = 900;
    artifacts.clear();
    daemon.mockReset();
    daemon.mockImplementation(async (request: { method: string }) =>
        request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT ? { success: true, snapshot }
            : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'No fixture response for this daemon operation' });
    await vi.waitFor(() => expect(storage.getState().projectAccountRows?.status).toBe('ready'));
    workspaceRef = { id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo',
        label: 'Project Alpha', projectKey: 'project-alpha', createdAtMs: 1, lastOpenedAtMs: null };
    applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspaceRef,
        ...worktrees.slice(1).map(tree => ({ ...workspaceRef, id: tree.id, rootPath: tree.path }))] });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', activeAt: Date.now() })], true,
        { sourceServerId: runtime.serverId });
    storage.setState({ settings: settingsParse({ ...storage.getState().settings,
        actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
        sessions: {}, localSettings: { ...storage.getState().localSettings,
        uiMultiPanePanelsEnabled: true } });
    replacePersistentUiStateForTest(projectLastActiveRootPathState, {});
    replacePersistentUiStateForTest(projectLastActiveWorktreeIdState, {});
    storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo' }, snapshot);
    // FIXPAR1-BRIEF.md:7 keeps checkout selection behind the mounted Workspace Action owner.
    // Mount its real reducer/navigation/guard; only the external router commit is inert here.
    let workspace = createWorkspaceState({ id: 'project', target: { kind: 'project', params: {
        workspaceRefId: workspaceRef.id, serverId: runtime.serverId, pageId: 'context',
    } }, pinned: false, preview: false });
    let nextId = 0;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: true, workflows: false, friends: false,
    } });
    const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => catalog,
        dispatch: action => { workspace = reduceWorkspaceState(workspace, action); }, createId: () => `project:${++nextId}`,
        onChange: () => {}, transport: { commit: () => {} } });
    navigation.initialize(`/projects/wr_1/context?serverId=${runtime.serverId}`);
    const execute = createWorkspaceActionAdapter({ getState: () => workspace, navigation,
        readCanvas: () => null, createId: () => `project:${++nextId}` });
    unregisterWorkspace = registerMountedWorkspaceAction(async request => {
        let result: WorkspaceActionOutcome = workspaceActionFailure('workspace_navigation_cancelled');
        await runGuardedNavigation(async () => { result = await execute(request.actionId, request.input); });
        return result;
    });
});
function setPreferences(rootPath: string, worktreeId: string) {
    projectLastActiveRootPathState.set('wr_1', rootPath);
    projectLastActiveWorktreeIdState.set('wr_1', worktreeId);
}
function selectionKey() { return `project-selection:v1:${JSON.stringify([runtime.serverId, 'wr_1'])}`; }
it('keeps Project route and New Session owners asleep during deferred File drafts and dirty pin metadata', async () => {
    let ownerRenders = 0;
    const scopeId = buildProjectPaneScopeId('wr_1', runtime.serverId);
    function ProjectRouteOwner() {
        const pane = useAppPaneScope(scopeId, () => null);
        useProjectInitialResource(pane, workspaceRef);
        useProjectRouteActions({ workspaceRef, activeRootPath: '/repo', pane });
        useProjectNewSessionAction({ workspaceRef, activeRootPath: '/repo', scopeId });
        ownerRenders += 1;
        return null;
    }
    await renderScreen(<runtime.Wrapper><ProjectRouteOwner /></runtime.Wrapper>);
    await act(async () => runtime.pane.openDetailsTab({ key: 'file:src/a.ts', kind: 'file', title: 'a.ts',
        resource: { kind: 'file', path: 'src/a.ts' } }, { intent: 'preview', present: false }));
    ownerRenders = 0;
    for (let index = 0; index < 20; index += 1) {
        await act(async () => {
            runtime.pane.patchDetailsTabState('file:src/a.ts', { accountId: 'account-a', isEditingFile: true,
                editorOriginalHash: 'base-hash', editorText: `draft ${index}` }, { persist: false });
            if (index === 0) runtime.pane.pinDetailsTab('file:src/a.ts', { persist: false });
        });
    }
    expect(ownerRenders).toBe(0);
});
async function mount(props: Partial<React.ComponentProps<typeof ProjectDetailScreen>> = {}) {
    const screen = await renderScreen(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
        serverId={runtime.serverId} page="context" {...props} /></runtime.Wrapper>);
    await act(async () => runtime.pane.openRight({ tabId: 'files' }));
    await vi.waitFor(() => expect(screen.findAllByType(ProjectRightPanel).length).toBeGreaterThan(0));
    return screen;
}
function rootPath(screen: Awaited<ReturnType<typeof mount>>) {
    const main = screen.findByType(ProjectCockpitShell);
    const right = screen.findByType(ProjectRightPanel);
    const header = screen.findByType(ProjectShellHeaderHost);
    expect(right.props.activeRootPath).toBe(main.props.activeRootPath);
    expect(header.props.activeRootPath).toBe(main.props.activeRootPath);
    return main.props.activeRootPath as string;
}

describe('ProjectDetailScreen active worktree selection', () => {
    it('names the selected Machine identically in the Project header and Checkouts when hosts repeat', async () => {
        const { ProjectBuiltinWidgetBody } = await import('./widgets/ProjectBuiltinWidgetBody');
        const { ProjectShellHeader } = await import('./shell/ProjectShellHeader');
        const { WidgetGlanceRow } = await import('@/components/widgets/glance/WidgetGlanceRow');
        const named = (id: string) => createMachineFixture({ id, metadata: {
            ...createMachineFixture().metadata!, host: 'NLDW3-5-36-33', displayName: 'NLDW3-5-36-33',
        } });
        storage.getState().applyMachines([named('machine-1'), named('machine-2')], true, { sourceServerId: runtime.serverId });
        const screen = await renderScreen(<runtime.Wrapper>
            <ProjectShellHeaderHost workspaceRef={workspaceRef} activeRootPath="/repo" onSelectRootPath={() => {}} page="overview" />
            <ProjectBuiltinWidgetBody id="project_checkouts" checkout={workspaceRef} testID="checkouts"
                workspace={{ serverId: runtime.serverId, workspaceId: workspaceRef.id, machineId: workspaceRef.machineId, rootPath: '/repo' }} />
        </runtime.Wrapper>);
        const headerName = screen.findByType(ProjectShellHeader).props.checkout.machineName;
        expect(headerName).toBe('NLDW3-5-36-33 · machine-1');
        const checkout = screen.findAllByType(WidgetGlanceRow).find(node => node.props.testID === 'checkouts.here');
        expect(checkout?.props.fact.split(' · ').slice(0, 2).join(' · ')).toBe(headerName);
        await screen.unmount();
    });
    it('names no Machine while its name is resolving, never its id (resolving is its own state)', async () => {
        const { ProjectShellHeader } = await import('./shell/ProjectShellHeader');
        // Its record has arrived but its content is still opening: no name yet, and no id standing in for one.
        const machine = createMachineFixture({ id: 'machine-1' });
        storage.getState().applyMachines([{ ...machine, metadata: null, availability: undefined }], true, { sourceServerId: runtime.serverId });
        const screen = await renderScreen(<runtime.Wrapper>
            <ProjectShellHeaderHost workspaceRef={workspaceRef} activeRootPath="/repo" onSelectRootPath={() => {}} page="overview" />
        </runtime.Wrapper>);
        const checkout = () => screen.findByType(ProjectShellHeader).props.checkout;
        expect([checkout().machineName, checkout().machineNameParts.name]).toEqual(['', '']);
        // The display metadata the Projects tree names it by names the chip too, before its content opens.
        await act(async () => {
            storage.getState().replaceMachineDisplays([{ ...machine, metadata: { ...machine.metadata!, displayName: 'Build machine' } }],
                { sourceServerId: runtime.serverId });
        });
        expect(checkout().machineNameParts.name).toBe('Build machine');
        await screen.unmount();
    });
    it('renders the comparison-seeded review Start form from phone Project Changes', async () => {
        viewport.width = 390;
        viewport.height = 844;
        const changedSnapshot = ScmWorkingSnapshotSchema.parse({ ...snapshot,
            entries: [{ path: 'notes.md', previousPath: null, kind: 'modified', includeStatus: '.', pendingStatus: 'M',
                hasIncludedDelta: false, hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false } }],
            totals: { ...snapshot.totals, pendingFiles: 1, pendingAdded: 1 },
        });
        daemon.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT
            ? { success: true, snapshot: changedSnapshot }
            : { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'No fixture response for this daemon operation' });
        storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo' }, changedSnapshot);
        const { Modal, ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<runtime.Wrapper>
            <ProjectDetailScreen workspaceRefId="wr_1" serverId={runtime.serverId} page="changes" />
            <ModalProvider>{null}</ModalProvider>
        </runtime.Wrapper>);
        try {
            const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
            await vi.waitFor(() => expect(screen.findByTestId('scm-comparison-phone-actions')).not.toBeNull());
            let menu!: ReturnType<typeof screen.root.find>;
            await vi.waitFor(() => {
                menu = screen.root.find(node => node.type === DropdownMenu && node.props.testID === 'scm-comparison-phone-actions'
                    && node.props.items.some((item: { id: string }) => item.id === 'start-review'));
                expect(menu.props.items.find((item: { id: string }) => item.id === 'start-review').disabled).toBe(false);
            });
            await act(async () => menu.props.onSelect('start-review'));
            await vi.waitFor(() => expect(screen.findByTestId('execution-run-start-form')).not.toBeNull());
            expect(screen.getTextContent()).toContain('scmComparison.scope.workingTree');
            expect(screen.getTextContent()).toContain('scmComparison.onBranch(branch=main)');
            expect(screen.getTextContent()).toContain('/repo');
        } finally {
            await act(async () => Modal.hideAll());
            await screen.unmount();
        }
    });
    it('publishes the focused Project and accepted checkout through the real current-context Action without paths or sibling reads', async () => {
        const otherProject = { ...workspaceRef, id: 'wr_other', projectKey: 'project-beta', label: 'Project Beta', rootPath: '/other' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspaceRef,
            ...worktrees.slice(1).map(tree => ({ ...workspaceRef, id: tree.id, rootPath: tree.path })), otherProject] });
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: runtime.serverId, expectedAccountId: 'account-a' };
        const tree = (active: boolean, feature = false, other = false, showProject = true) => <runtime.Wrapper><MainAppTabStateProvider>
            <CurrentUiContextProvider><CurrentUiContextActionHost />
                <PluginSurfaceFocusEligibilityProvider active={active} currentUiContextActive={active}>
                    {showProject ? <ProjectDetailScreen workspaceRefId={other ? otherProject.id : workspaceRef.id} serverId={runtime.serverId} page="context"
                        activeRootPath={other ? otherProject.rootPath : feature ? '/repo/.worktrees/feature-auth' : '/repo'}
                        activeWorktreeId={feature ? 'gitwt_feature' : null} isFocused={active} /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider>
        </MainAppTabStateProvider></runtime.Wrapper>;
        const screen = await renderScreen(tree(true));
        const executor = createDefaultActionExecutor();
        const read = () => executor.execute('ui.current_context.read', {}, context);
        expect(await read()).toMatchObject({ ok: true, result: { entity: { kind: 'project', label: 'Project Alpha',
            reference: { serverId: runtime.serverId, projectKey: 'project-alpha', workspaceId: 'wr_1',
                machineId: 'machine-1', worktreeId: null } } } });
        await screen.update(tree(true, true));
        const requests = daemon.mock.calls.length;
        const selected = await read();
        expect(selected).toMatchObject({ ok: true, result: { entity: { reference: {
            workspaceId: 'gitwt_feature', worktreeId: 'gitwt_feature' } } } });
        expect(JSON.stringify(selected)).not.toContain('/repo');
        expect(daemon.mock.calls.length).toBe(requests);
        await screen.update(tree(false, true));
        const inactive = await read();
        expect(inactive).toMatchObject({ ok: true });
        expect(inactive).not.toMatchObject({ result: { entity: expect.anything() } });
        await screen.update(tree(true, true));
        expect(await read()).toMatchObject({ ok: true, result: { entity: { reference: { workspaceId: 'gitwt_feature' } } } });
        await screen.update(tree(true, false, true));
        expect(await read()).toMatchObject({ ok: true, result: { entity: { label: 'Project Beta', reference: {
            projectKey: 'project-beta', workspaceId: 'wr_other', worktreeId: null } } } });
        await screen.update(tree(true, false, true, false));
        const leftProject = await read();
        expect(leftProject).toMatchObject({ ok: true });
        expect(leftProject).not.toMatchObject({ result: { entity: expect.anything() } });
        await screen.unmount();
    });
    it('keeps a removed plugin page unavailable without probing SCM until its Files companion opens', async () => {
        const selection = { kind: 'plugin', destination: { pluginId: 'acme.removed', localId: 'builds' }, subPath: 'runs/42' } as const;
        // A visible Files companion legitimately reads SCM independently of the page body.
        paneUiState.set(buildProjectPaneScopeId('wr_1', runtime.serverId), {
            ...EMPTY_PERSISTED_PANE_SCOPE_STATE,
            right: { isOpen: false, activeTabId: 'files', selectedDestination: null, tabState: {} },
        });
        const screen = await renderScreen(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
            serverId={runtime.serverId} selection={selection} /></runtime.Wrapper>);
        expect(screen.findHostByTestId('plugin-app-page-unavailable')).not.toBeNull();
        expect(screen.findAllByType(ProjectOverviewWidgets)).toHaveLength(0);
        expect(screen.findHostByTestId('project-shell-header')).not.toBeNull();
        expect(screen.findAllByType(ProjectRightPanel)).toHaveLength(0);
        expect(daemon.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toHaveLength(0);
        await act(async () => runtime.pane.openRight({ tabId: 'files' }));
        await vi.waitFor(() => expect(daemon.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toHaveLength(1));
        expect(screen.findAllByType(ProjectRightPanel).length).toBeGreaterThan(0);
        expect(screen.findHostByTestId('plugin-app-page-unavailable')).not.toBeNull();
        expect(screen.findAllByType(ProjectOverviewWidgets)).toHaveLength(0);
        await screen.unmount();
    });
    it('keeps the Project header on the wide page column for every page while Overview/Code bodies are wide and the rest keep the default cap', async () => {
        storage.setState({ localSettings: { ...storage.getState().localSettings, uiContentWidthMode: 'compact' } });
        const renderProject = (page: 'overview' | 'code' | 'changes' | 'scripts' | 'services' | 'context') => (
            <runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1" serverId={runtime.serverId} page={page} /></runtime.Wrapper>
        );
        const screen = await renderScreen(renderProject('overview'));
        const flattenStyle = (style: unknown): Record<string, unknown> => Array.isArray(style)
            ? Object.assign({}, ...style.map(flattenStyle))
            : style && typeof style === 'object' ? style as Record<string, unknown> : {};
        const headerWidth = () => flattenStyle(screen.findHostByTestId('project-shell-header')?.props.style).maxWidth;
        const columnWidth = (component: typeof screen.root) => {
            const column = component.findAll(node => typeof node.type === 'string'
                && flattenStyle(node.props.style).maxWidth !== undefined)[0];
            return flattenStyle(column?.props.style).maxWidth;
        };
        await vi.waitFor(() => expect(screen.findAllByTestId('project-overview').length).toBeGreaterThan(0));
        expect(headerWidth()).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);
        expect(columnWidth(screen.findByType(ProjectOverviewWidgets))).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);

        await screen.update(renderProject('code'));
        expect(headerWidth()).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);
        await vi.waitFor(() => expect(screen.findHostByTestId('workspace-code')).not.toBeNull());
        const codeSurface = screen.findHostByTestId('workspace-code');
        expect(codeSurface ? columnWidth(codeSurface) : undefined).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);

        for (const page of ['changes', 'scripts', 'services', 'context'] as const) {
            await screen.update(renderProject(page));
            expect(headerWidth()).toBe(PAGE_COLUMN_MAX_WIDTH_PX.wide);
        }
        // The header is the only wide column left on Context, so a reading-width column is the body's.
        await vi.waitFor(() => expect(screen.root.findAll(node => typeof node.type === 'string'
            && flattenStyle(node.props.style).maxWidth === PAGE_COLUMN_MAX_WIDTH_PX.reading).length).toBeGreaterThan(0));
        expect(screen.findByType(ProjectShellHeaderHost).props.activeRootPath).toBe('/repo');
    });

    it('preserves a dismissed project pane and its restored plugin destination on entry', async () => {
        const destination = { kind: 'plugin' as const, destination: { pluginId: 'acme.review', localId: 'project-review' } };
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => {
            runtime.pane.selectRightDestination(destination);
            runtime.pane.closeRight();
        });
        await screen.update(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
            serverId={runtime.serverId} page="context" /></runtime.Wrapper>);
        expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
        expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(destination);
    });

    it('keeps the main panel, header and right panel in sync when the active worktree changes', async () => {
        const screen = await mount();
        expect(rootPath(screen)).toBe('/repo');
        const settingsWrite = vi.spyOn(storage.getState(), 'applyLocalSettings');
        try {
            await act(async () => screen.findByType(ProjectRightPanel).props.onSelectRootPath('/repo/.worktrees/feature-auth'));
            expect(rootPath(screen)).toBe('/repo/.worktrees/feature-auth');
            expect(projectLastActiveRootPathState.read(selectionKey())).toBe('/repo/.worktrees/feature-auth');
            expect(projectLastActiveWorktreeIdState.read(selectionKey())).toBe('gitwt_feature');
            expect(settingsWrite).not.toHaveBeenCalled();
        } finally { settingsWrite.mockRestore(); }
    });

    it('does not carry uncontrolled checkout selection into another Home with the same id', async () => {
        const other = { ...workspaceRef, serverId: 'other-home', rootPath: '/other', projectKey: 'other-project' };
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [workspaceRef, other] });
        const screen = await mount();
        await act(async () => screen.findByType(ProjectRightPanel).props.onSelectRootPath('/repo/.worktrees/feature-auth'));
        await screen.update(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
            serverId="other-home" page="context" /></runtime.Wrapper>);
        expect(screen.findByType(ProjectCockpitShell).props.activeRootPath).toBe('/other');
    });

    it('prefers the persisted active worktree path when the screen is uncontrolled', async () => {
        setPreferences('/repo/.worktrees/feature-persisted', 'gitwt_persisted');
        expect(rootPath(await mount())).toBe('/repo/.worktrees/feature-persisted');
    });

    it('falls back to the base project root when a persisted worktree path no longer exists', async () => {
        setPreferences('/repo/.worktrees/deleted-worktree', 'gitwt_deleted');
        const screen = await mount();
        expect(rootPath(screen)).toBe('/repo');
        expect(screen.findByTestId('project-worktree-recovery-toast')).not.toBeNull();
        expect(projectLastActiveRootPathState.readAll()).toEqual({
            wr_1: '/repo/.worktrees/deleted-worktree', [selectionKey()]: '/repo',
        });
    });

    it('dismisses the worktree recovery notice after the controlled route switches to the repaired checkout', async () => {
        const screen = await mount({ activeRootPath: '/repo' });
        const onSelectRootPath = vi.fn();
        const updateCheckout = (activeRootPath: string) => screen.update(<runtime.Wrapper>
            <ProjectDetailScreen workspaceRefId="wr_1" activeRootPath={activeRootPath} onSelectRootPath={onSelectRootPath} />
        </runtime.Wrapper>);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            await updateCheckout('/repo/.worktrees/deleted-worktree');
            expect(onSelectRootPath).toHaveBeenCalledWith('/repo');
            expect(screen.findByTestId('project-worktree-recovery-toast')).not.toBeNull();
            await updateCheckout('/repo');
            expect(screen.findByTestId('project-worktree-recovery-toast')).not.toBeNull();
            await act(async () => { vi.runOnlyPendingTimers(); });
            expect(screen.findByTestId('project-worktree-recovery-toast')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('repairs a controlled invalid worktree path through onSelectRootPath so route-backed screens recover', async () => {
        const onSelectRootPath = vi.fn();
        const screen = await mount({ activeRootPath: '/repo/.worktrees/deleted-worktree', onSelectRootPath });
        expect(rootPath(screen)).toBe('/repo');
        expect(onSelectRootPath).toHaveBeenCalledWith('/repo');
    });

    it('does not repair or persist route-backed worktree state while unfocused', async () => {
        const onSelectRootPath = vi.fn();
        await mount({ activeRootPath: '/repo/.worktrees/deleted-worktree', isFocused: false, onSelectRootPath });
        expect(onSelectRootPath).not.toHaveBeenCalled();
        expect(projectLastActiveRootPathState.readAll()).toEqual({});
    });

    it('adopts a persisted active worktree path when device state hydrates after mount', async () => {
        const screen = await mount();
        expect(rootPath(screen)).toBe('/repo');
        await act(async () => setPreferences('/repo/.worktrees/feature-hydrated', 'gitwt_hydrated'));
        expect(rootPath(screen)).toBe('/repo/.worktrees/feature-hydrated');
    });

    it('keeps the main repository selected when the user explicitly switches back from a worktree', async () => {
        setPreferences('/repo/.worktrees/feature-persisted', 'gitwt_persisted');
        const screen = await mount();
        expect(rootPath(screen)).toBe('/repo/.worktrees/feature-persisted');
        await act(async () => screen.findByType(ProjectRightPanel).props.onSelectRootPath('/repo'));
        expect(rootPath(screen)).toBe('/repo');
        expect(projectLastActiveRootPathState.readAll()).toEqual({
            wr_1: '/repo/.worktrees/feature-persisted', [selectionKey()]: '/repo',
        });
        expect(projectLastActiveWorktreeIdState.readAll()).toEqual({
            wr_1: 'gitwt_persisted', [selectionKey()]: '@root',
        });
    });

    // The File page's kept key row and a selection's Ask bar report to this seat so they stack instead of overlapping
    // (as on the Session cockpit); a page the Project hosts without it would let the Ask bar cover the key row.
    it('seats the page and its details companion under one bottom-bar seat so the Ask bar clears the Edit key row', async () => {
        const screen = await mount({ page: 'code' });
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a', resource: { kind: 'file', path: 'a' } }));
        const ancestors: unknown[] = [];
        for (let node = screen.findByType(ProjectCockpitShell).parent; node; node = node.parent) ancestors.push(node.type);
        expect(ancestors).toContain(PageBottomBarSeatProvider);
    });

    // Plan 12 §§2/4 replaced the three-segment forceOverviewMode owner with route-owned pages.
    // Details is now a companion; opening it must not silently choose a different primary page.
    it('renders the explicit Overview page on desktop', async () => {
        const screen = await mount({ page: 'overview' });
        expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
        expect(screen.findByType(ProjectOverviewWidgets).props.activeRootPath).toBe('/repo');
    });

    it('keeps an explicit Overview visible when it is opened while details already exist', async () => {
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a', resource: { kind: 'file', path: 'a' } }));
        await screen.update(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
            serverId={runtime.serverId} page="overview" /></runtime.Wrapper>);
        expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
        expect(screen.findByType(ProjectOverviewWidgets).props.activeRootPath).toBe('/repo');
    });

    // Lane 12 Fork C ruling 23:16Z: "Available on" (Machines with a checkout, Add machine) is reachable from the Project.
    it('opens the Project\'s Available on details from its own menu, in the details pane', async () => {
        const { ProjectShellHeaderHost } = await import('./shell/ProjectShellHeaderHost');
        const screen = await mount({ page: 'overview' });
        const action = (screen.findByType(ProjectShellHeaderHost).props.menuActions as { id: string; onSelect: () => void }[])
            .find((candidate) => candidate.id === 'availableOn');
        expect(action, 'the Project menu offers Available on').toBeDefined();
        await act(async () => action!.onSelect());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
        expect(runtime.pane.scopeState?.details.tabs.map((tab) => tab.kind)).toContain('workspaceInfo');
        // The page under it stays the route's own Overview.
        expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
    });

    it.each([1440, 390])('lets an agent open Available on at viewport %i and retires the command with the Project', async (width) => {
        viewport.width = width;
        const { CurrentUiContextSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/currentUiContext');
        const context = { surface: 'agent' as const, authority: 'account_automation' as const,
            serverId: runtime.serverId, expectedAccountId: 'account-a' };
        const tree = (showProject: boolean) => <runtime.Wrapper><MainAppTabStateProvider>
            <CurrentUiContextProvider><CurrentUiContextActionHost />
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                    {showProject ? <ProjectDetailScreen workspaceRefId="wr_1" serverId={runtime.serverId} page="overview" isFocused /> : null}
                </PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider>
        </MainAppTabStateProvider></runtime.Wrapper>;
        const screen = await renderScreen(tree(true));
        try {
            const executor = createDefaultActionExecutor();
            const result = await executor.execute('ui.current_context.read', {}, context);
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error(result.errorCode);
            const command = CurrentUiContextSnapshotV1Schema.parse(result.result).commands
                .find(candidate => candidate.title === 'workspaceSync.availableOn');
            expect(command, 'the Project menu operation is discoverable through the current UI Action').toBeDefined();
            if (!command) throw new Error('Available on command is missing');
            await act(async () => {
                expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, context))
                    .toMatchObject({ ok: true });
            });
            expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
            expect(runtime.pane.scopeState?.details.tabs.map(tab => tab.kind)).toContain('workspaceInfo');
            expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
            await screen.update(tree(false));
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: command.id }, context))
                .toMatchObject({ ok: false });
        } finally {
            await screen.unmount();
        }
    });

    it('retains the route-owned Overview and checkout when a details companion opens', async () => {
        const screen = await mount({ page: 'overview' });
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a', resource: { kind: 'file', path: 'a' } }));
        expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
        expect(screen.findByType(ProjectOverviewWidgets).props.activeRootPath).toBe('/repo');
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
    });
});
