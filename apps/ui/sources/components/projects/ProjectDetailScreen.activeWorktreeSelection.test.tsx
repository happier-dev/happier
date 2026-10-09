import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

installSessionDetailsPanelNonRnModuleMocks();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }) },
    });
});
const daemon = vi.hoisted(() => vi.fn());
// Only the addressed daemon transport is replaced; SCM selection, storage and pane lifecycle stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: daemon }));

const { storage } = await import('@/sync/domains/state/storage');
const { buildProjectPaneScopeId } = await import('./detail/projectPaneScope');
const { ProjectDetailScreen } = await import('./ProjectDetailScreen');
const { ProjectRightPanel } = await import('./detail/ProjectRightPanel');
const { ProjectCockpitShell } = await import('@/components/workspaceCockpit/project/ProjectCockpitShell');
const { ProjectShellHeaderHost } = await import('./shell/ProjectShellHeaderHost');
const { ProjectOverviewWidgets } = await import('./detail/ProjectOverviewWidgets');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);

const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const runtime = installSessionPaneRuntimeTestHarness({
    scopeId: ({ serverId }) => buildProjectPaneScopeId('wr_1', serverId),
    request: async (url, init) => artifacts.handle(new URL(String(url)).pathname, init),
});
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
beforeEach(async () => {
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
    storage.setState({ sessions: {}, localSettings: { ...storage.getState().localSettings,
        uiMultiPanePanelsEnabled: true, projectLastActiveRootPathByWorkspaceRefId: {},
        projectLastActiveWorktreeIdByWorkspaceRefId: {} } });
    storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/repo' }, snapshot);
});
function setPreferences(rootPath: string, worktreeId: string) {
    storage.setState({ localSettings: { ...storage.getState().localSettings,
        projectLastActiveRootPathByWorkspaceRefId: { wr_1: rootPath },
        projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: worktreeId } } });
}
function selectionKey() { return `project-selection:v1:${JSON.stringify([runtime.serverId, 'wr_1'])}`; }
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
    it('reopens a closed project pane without overwriting its restored plugin destination', async () => {
        const destination = { kind: 'plugin' as const, destination: { pluginId: 'acme.review', localId: 'project-review' } };
        const screen = await renderScreen(<runtime.Wrapper />);
        await act(async () => {
            runtime.pane.selectRightDestination(destination);
            runtime.pane.closeRight();
        });
        await screen.update(<runtime.Wrapper><ProjectDetailScreen workspaceRefId="wr_1"
            serverId={runtime.serverId} page="context" /></runtime.Wrapper>);
        expect(runtime.pane.scopeState?.right.isOpen).toBe(true);
        expect(runtime.pane.scopeState?.right.selectedDestination).toEqual(destination);
    });

    it('keeps the main panel, header and right panel in sync when the active worktree changes', async () => {
        const screen = await mount();
        expect(rootPath(screen)).toBe('/repo');
        await act(async () => screen.findByType(ProjectRightPanel).props.onSelectRootPath('/repo/.worktrees/feature-auth'));
        expect(rootPath(screen)).toBe('/repo/.worktrees/feature-auth');
        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId)
            .toEqual({ [selectionKey()]: '/repo/.worktrees/feature-auth' });
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
        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId).toEqual({
            wr_1: '/repo/.worktrees/deleted-worktree', [selectionKey()]: '/repo',
        });
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
        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId).toEqual({});
    });

    it('adopts a persisted active worktree path when local settings hydrate after mount', async () => {
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
        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId).toEqual({
            wr_1: '/repo/.worktrees/feature-persisted', [selectionKey()]: '/repo',
        });
        expect(storage.getState().localSettings.projectLastActiveWorktreeIdByWorkspaceRefId).toEqual({
            wr_1: 'gitwt_persisted', [selectionKey()]: '@root',
        });
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

    it('retains the route-owned Overview and checkout when a details companion opens', async () => {
        const screen = await mount({ page: 'overview' });
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a', resource: { kind: 'file', path: 'a' } }));
        expect(screen.findByType(ProjectCockpitShell).props.surface).toBe('overview');
        expect(screen.findByType(ProjectOverviewWidgets).props.activeRootPath).toBe('/repo');
        expect(runtime.pane.scopeState?.details.isOpen).toBe(true);
    });
});
