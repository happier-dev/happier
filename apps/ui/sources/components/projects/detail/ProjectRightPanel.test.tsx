import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, flattenTestStyle, renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { registerMountedWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { createWorkspaceActionAdapter } from '@/components/appShell/workspace/workspaceActions';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
const device = vi.hoisted(() => ({ phone: false }));
vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
}));
installSessionDetailsPanelNonRnModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/projects/wr_1/code', router: { replace: router.replace } }).module;
    },
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: device.phone ? 390 : 1440, height: device.phone ? 844 : 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1' });
let restoreWebGlobals: (() => void) | undefined;
let unregisterWorkspace: (() => void) | undefined;
beforeEach(() => {
    device.phone = false;
    router.replace.mockClear();
    // Browser hardware is the mobile-host boundary; width alone still describes a desktop browser.
    vi.stubGlobal('navigator', { get userAgent() { return device.phone ? 'iPhone' : 'X11'; } });
    restoreWebGlobals = withPopoverWebGlobals();
    let state = createWorkspaceState({ id: 'project-right-panel', target: { kind: 'project',
        params: { workspaceRefId: 'wr_1', serverId: runtime.serverId, pageId: 'overview' } }, pinned: false, preview: false });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false,
        inbox: true, workflows: false, friends: false } });
    let nextId = 0;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
        dispatch: action => { state = reduceWorkspaceState(state, action); }, createId: () => `panel:${++nextId}`,
        onChange: () => {},
        // Browser History is the boundary; the workspace and Action adapters remain real.
        transport: { commit: (href, _entry, replace) => { if (replace) router.replace(href); } },
    });
    navigation.initialize(`/projects/wr_1/overview?serverId=${runtime.serverId}`);
    const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null,
        createId: () => `panel:${++nextId}` });
    unregisterWorkspace = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
    router.replace.mockClear();
});
afterEach(() => {
    unregisterWorkspace?.(); unregisterWorkspace = undefined;
    restoreWebGlobals?.(); restoreWebGlobals = undefined; vi.unstubAllGlobals();
});
function workspaceRef(): WorkspaceRefV1 {
    return { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 };
}
async function renderPanel(props: Partial<React.ComponentProps<typeof import('./ProjectRightPanel')['ProjectRightPanel']>> = {},
    onRender: React.ProfilerOnRenderCallback = () => {}, wrap: (content: React.ReactNode) => React.ReactNode = content => content) {
    const { ProjectRightPanel } = await import('./ProjectRightPanel');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => runtime.pane.openRight({ tabId: 'git' }));
    await act(async () => screen.update(<runtime.Wrapper><DestinationInstanceHost tabId="project-right-panel"
        ref={{ kind: 'project', params: { workspaceRefId: 'wr_1', serverId: runtime.serverId } }}
        pathname={device.phone ? '/projects/wr_1/overview' : '/projects/wr_1/code'} focused visible
        navigation={{ push: () => {}, replace: router.replace, back: () => {}, setParams: () => {} }}>
        <React.Profiler id="project-right" onRender={onRender}>
            {wrap(<ProjectRightPanel workspaceRef={workspaceRef()} scopeId="project:wr_1" activeRootPath="/repo"
                onSelectRootPath={() => {}} {...props} />)}
        </React.Profiler>
    </DestinationInstanceHost></runtime.Wrapper>));
    await flushHookEffects({ cycles: 30 });
    return screen;
}
describe('ProjectRightPanel', () => {
    it.each(['cleared', 'reading'] as const)('inherits the shell content material (%s) instead of hiding the wallpaper behind its shared tab frame', async (coat) => {
        const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const onPicture = (content: React.ReactNode) => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
                <GlassSurface plane surfaceGroup="content" atmosphereCoat={coat === 'reading' ? 'reading' : undefined}>{content}</GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;

        const screen = await renderPanel({}, () => {}, onPicture);
        const root = screen.findHostByTestId('project-right-panel-root')!;
        // Web binds this paint to the containing surface's plane variable, which that surface clears over a picture.
        expect(flattenTestStyle(root.props.style).backgroundColor).toContain('var(--happier-glass-content-plane-background-color,');
        let surface = root.parent;
        while (surface && flattenTestStyle(surface.props.style)['--happier-glass-content-plane-background-color'] === undefined) surface = surface.parent;
        expect(flattenTestStyle(surface?.props.style)['--happier-glass-content-plane-background-color']).toBe('transparent');
    });
    it.each(['git', 'files'])('keeps the %s sidebar asleep for unrelated File drafts and publishes the current right selection', async activeTab => {
        let commits = 0;
        const screen = await renderPanel({}, () => { commits += 1; });
        if (activeTab === 'files') await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        await act(async () => runtime.pane.openDetailsTab({ key: 'file:a', kind: 'file', title: 'a.ts',
            resource: { kind: 'file', path: 'src/a.ts' } }, { intent: 'preview', present: false }));
        await flushHookEffects({ cycles: 20 });
        commits = 0;
        for (let index = 0; index < 20; index += 1) {
            await act(async () => {
                runtime.pane.patchDetailsTabState('file:a', { accountId: 'account-a', isEditingFile: true,
                    editorOriginalHash: 'base-hash', editorText: `draft ${index}` }, { persist: false });
                if (index === 0) runtime.pane.pinDetailsTab('file:a', { persist: false });
            });
        }
        expect(commits).toBe(0);
        const nextTab = activeTab === 'git' ? 'files' : 'git';
        await screen.pressByTestIdAsync(`project-rightpanel-tab:${nextTab}`);
        expect(commits).toBeGreaterThan(0);
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: nextTab });
    });
    it('renders the canonical Git surface without a close affordance when the parent supplies none', async () => {
        const { ProjectGitSurface } = await import('./surfaces/ProjectGitSurface');
        const screen = await renderPanel();
        expect(screen.tree.findAllByType(ProjectGitSurface)).toHaveLength(1);
        expect(screen.findHostByTestId('project-rightpanel-header')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('selects Files in the real pane and opens the Code page for the root checkout on phone', async () => {
        device.phone = true;
        const screen = await renderPanel({ activeWorktreeId: null, onRequestClose: () => {} });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith(`/projects/wr_1/code?serverId=${encodeURIComponent(runtime.serverId)}&worktreeId=%40root`);
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('says an unreachable checkout at the top of the pane, beside the page (desktop) and over it (phone)', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { createMachineFixture } = await import('@/dev/testkit');
        const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
        const lastHeartbeat = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(lastHeartbeat + 24 * 60 * 60 * 1000);
            await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'm1', active: false,
                activeAt: lastHeartbeat, seq: 2, updatedAt: Date.now() })], true, { sourceServerId: runtime.serverId }));
            const lines = async () => (await renderPanel({ onRequestClose: () => {} })).tree.findAllByType(SurfaceFreshnessLine)
                .map(line => line.props.testID);
            // The page's line spans only its own column: a pane beside it would otherwise sit blank under its header.
            expect(await lines()).toEqual(['project-rightpanel-reachability']);
            device.phone = true;
            expect(await lines()).toEqual(['project-rightpanel-reachability']);
        } finally { vi.useRealTimers(); }
    });
    it('preserves the selected worktree in the sibling mobile route and pane selection', async () => {
        device.phone = true;
        const screen = await renderPanel({
            activeRootPath: '/repo/.worktrees/feature-auth', activeWorktreeId: 'gitwt_feature', onRequestClose: () => {},
        });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith(`/projects/wr_1/code?serverId=${encodeURIComponent(runtime.serverId)}&worktreeId=gitwt_feature`);
    });
});
