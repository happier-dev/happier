import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '@happier-dev/protocol';
import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSessionRouteCommonModuleMocks } from '../../session/[id]/sessionRouteTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock({ params: { workspaceRefId: 'wr_1', worktreeId: 'gitwt_feature' } });
let deviceType: 'phone' | 'tablet' | 'desktop' = 'phone';
let isFocused = true;
let rightPaneState: { isOpen: boolean; activeTabId: string | null };
let localSettingsFixture: Partial<LocalSettings> & { projectLastMobileRouteByWorkspaceRefId?: Record<string, string> };
let accountSettingsFixture: Partial<Settings>;
let mobileSurfaceFixture: LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'];
let workspaceRef: WorkspaceRefV1 | null;
let snapshot: ScmWorkingSnapshot;
let navigationBoundary: ReturnType<typeof import('@/dev/testkit/mocks/reactNavigation').createReactNavigationNativeMock>;
let ProjectDetailScreen: typeof import('@/components/projects/ProjectDetailScreen').ProjectDetailScreen;
let ProjectCockpitShell: typeof import('@/components/workspaceCockpit/project/ProjectCockpitShell').ProjectCockpitShell;

installSessionRouteCommonModuleMocks({
    router: () => routerMock.module,
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: deviceType === 'phone' ? 390 : 1280, height: deviceType === 'phone' ? 844 : 900, scale: 1, fontScale: 1 }),
        });
    },
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        navigationBoundary = createReactNavigationNativeMock({ navigation: { canGoBack: () => true } });
        return { ...navigationBoundary, useIsFocused: () => isFocused };
    },
});
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

function createSnapshot(): ScmWorkingSnapshot {
    return {
        fetchedAt: 1, projectKey: 'machine-1:/Users/test/repo',
        repo: { isRepo: true, rootPath: '/Users/test/repo', backendId: 'git', mode: '.git', remotes: [],
            worktrees: [
                { id: 'gitwt_main', path: '/Users/test/repo', branch: 'main', isCurrent: true, isMain: true },
                { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
            ] },
        capabilities: createScmCapabilities({ readStatus: true }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    };
}

beforeEach(() => {
    deviceType = 'phone'; isFocused = true;
    rightPaneState = { isOpen: true, activeTabId: 'git' };
    localSettingsFixture = {}; accountSettingsFixture = {}; mobileSurfaceFixture = {};
    snapshot = createSnapshot();
    workspaceRef = WorkspaceRefV1Schema.parse({
        id: 'wr_1', serverId: runtime.serverId, machineId: 'machine-1',
        rootPath: '/Users/test/repo', label: 'Project Alpha', createdAtMs: 1,
    });
    routerMock.resetParams();
    routerMock.state.router.setParams({ workspaceRefId: 'wr_1', worktreeId: 'gitwt_feature' });
    routerMock.spies.replace.mockClear();
});

async function renderProjectRoute() {
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic', ...accountSettingsFixture,
        workspaceRefsV1: workspaceRef ? [workspaceRef] : [] });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', storageMode: 'plain', activeAt: Date.now() })], true, { sourceServerId: runtime.serverId });
    const realm = storage.getState().profileScope;
    if (!realm) throw new Error('Expected admitted Account realm');
    const surfaces: LocalSettings['projectLastMobileSurfaceByWorkspaceRefId'] = {};
    for (const [id, surface] of Object.entries(mobileSurfaceFixture)) {
        const key = buildRealmQualifiedMobileSurfaceStorageKey('project', realm, id);
        if (!key) throw new Error('Expected realm-qualified Project preference key');
        surfaces[key] = surface;
    }
    storage.getState().applyLocalSettings({ ...localSettingsFixture, projectLastMobileSurfaceByWorkspaceRefId: surfaces });
    storage.getState().updateWorkspaceScmSnapshot({ serverId: runtime.serverId, machineId: 'machine-1', rootPath: '/Users/test/repo' }, snapshot);
    const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
    ({ ProjectDetailScreen } = await import('@/components/projects/ProjectDetailScreen'));
    ({ ProjectCockpitShell } = await import('@/components/workspaceCockpit/project/ProjectCockpitShell'));
    const screen = await renderScreen(<runtime.Wrapper />);
    if (rightPaneState.isOpen) await act(async () => runtime.pane.openRight({ tabId: rightPaneState.activeTabId ?? 'files' }));
    await screen.update(<runtime.Wrapper>
        <navigationBoundary.NavigationContext.Provider value={navigationBoundary.useNavigation()}><Screen /></navigationBoundary.NavigationContext.Provider>
    </runtime.Wrapper>);
    return screen;
}

describe('project index redirect', () => {
    it('preserves the active root path search param when redirecting phone routes', async () => {
        rightPaneState = { isOpen: true, activeTabId: 'git' };
        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });

    it('renders the project cockpit shell on phone when the overview cockpit surface is enabled', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        mobileSurfaceFixture = { wr_1: 'overview' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const cockpit = screen.findByType(ProjectCockpitShell);
        expect(cockpit.props.workspaceRef.id).toBe('wr_1');
        expect(cockpit.props.surface).toBe('overview');
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
    });

    it('preserves a non-worktree active root path when canonicalizing cockpit index routes', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsFixture = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/packages/ui' },
        };
        mobileSurfaceFixture = { wr_1: 'services' };
        snapshot = { ...snapshot, repo: { ...snapshot.repo, isRepo: false } };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
            mobileSurface: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe(
            '/projects/wr_1?activeRootPath=%2FUsers%2Ftest%2Frepo%2Fpackages%2Fui&mobileSurface=services',
        );
    });

    it('canonicalizes an invalid persisted worktree before reopening a cockpit-only surface from the index route', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsFixture = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/deleted-worktree' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_deleted' },
        };
        mobileSurfaceFixture = { wr_1: 'terminal' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/terminal?worktreeId=%40root');

        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId.wr_1).toBe('/Users/test/repo');
    });

    it('does not redirect or persist canonical route state while the index route is unfocused', async () => {
        isFocused = false;
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsFixture = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/deleted-worktree' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_deleted' },
        };
        mobileSurfaceFixture = { wr_1: 'terminal' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        expect(screen.findByType(ProjectCockpitShell)).toBeTruthy();
        expect(storage.getState().localSettings.projectLastActiveRootPathByWorkspaceRefId.wr_1).toBe('/Users/test/repo/.worktrees/deleted-worktree');
        expect(storage.getState().localSettings.projectLastActiveWorktreeIdByWorkspaceRefId.wr_1).toBe('gitwt_deleted');
    });

    it('defaults the phone redirect to files when no last project tab is remembered', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'classic' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it.each(['browser', 'services'] as const)(
        'preserves %s surface intent when classic project routing handles an index deep link',
        async (surface) => {
            rightPaneState = { isOpen: true, activeTabId: 'files' };
            accountSettingsFixture = { mobileWorkspaceExperienceV1: 'classic' };
            routerMock.state.router.setParams({
                workspaceRefId: 'wr_1',
                worktreeId: 'gitwt_feature',
                mobileSurface: surface,
            });

            const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
            const screen = await renderScreen(<Screen />);

            const redirect = screen.findByType('Redirect');
            expect(redirect.props.href).toBe(`/projects/wr_1/files?worktreeId=gitwt_feature&mobileSurface=${surface}`);
        },
    );

    it('ignores the retired persisted mobile project route state when url state is absent', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'classic' };
        localSettingsFixture = {
            projectLastMobileRouteByWorkspaceRefId: { wr_1: 'git' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=gitwt_feature');
    });

    it('falls back to persisted cockpit-era mobile surface state when url state is absent', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        localSettingsFixture = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        mobileSurfaceFixture = { wr_1: 'browse' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=gitwt_feature');
    });

    it('drops an invalid persisted worktree selection before redirecting phone routes', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'classic' };
        localSettingsFixture = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/deleted-worktree' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_deleted' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it('repairs an invalid explicit worktreeId before redirecting phone routes', async () => {
        rightPaneState = { isOpen: false, activeTabId: null };
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'classic' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_deleted',
            activeRootPath: undefined,
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it('preserves a deep-linked activeRootPath before the workspace ref has loaded', async () => {
        workspaceRef = null;
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_feature',
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });

    it('cannot borrow a realm-qualified Project preference before its target Home is proven', async () => {
        workspaceRef = null;
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        mobileSurfaceFixture = { wr_1: 'terminal' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_feature',
        });

        const screen = await renderProjectRoute();

        const redirect = screen.findByType('Redirect');
        expect(redirect.props.href).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });

    it('preserves the persisted terminal surface once the Project belongs to the admitted Home', async () => {
        accountSettingsFixture = { mobileWorkspaceExperienceV1: 'cockpit' };
        mobileSurfaceFixture = { wr_1: 'terminal' };
        const screen = await renderProjectRoute();

        expect(screen.findByType('Redirect').props.href).toBe('/projects/wr_1/terminal?worktreeId=gitwt_feature');
    });

    it('replaces the desktop route with the canonical project href when switching back to the main repository', async () => {
        deviceType = 'desktop';
        routerMock.spies.replace.mockClear();

        const screen = await renderProjectRoute();
        const detail = screen.findByType(ProjectDetailScreen);

        await act(async () => {
            detail.props.onSelectRootPath('/Users/test/repo');
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=%40root');
    });

    it('uses the canonical visible-worktree matcher when selecting a desktop worktree path', async () => {
        deviceType = 'desktop';
        routerMock.spies.replace.mockClear();

        const screen = await renderProjectRoute();
        const detail = screen.findByType(ProjectDetailScreen);

        await act(async () => {
            detail.props.onSelectRootPath('  /Users/test/repo/.worktrees/feature-auth  ');
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=gitwt_feature');
    });

    it('passes the desktop worktree-overview mode into the project screen when requested', async () => {
        deviceType = 'desktop';
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            showWorktrees: '1',
        });

        const screen = await renderProjectRoute();
        const detail = screen.findByType(ProjectDetailScreen);

        expect(detail.props.showWorktrees).toBe(true);
    });
});
