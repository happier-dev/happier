import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

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
        return createExpoRouterMock({ router: { replace: router.replace } }).module;
    },
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const dimensions = () => ({ width: device.phone ? 390 : 1440, height: device.phone ? 844 : 900, scale: 1, fontScale: 1 });
    return createReactNativeWebMock({ useWindowDimensions: dimensions, Dimensions: { get: dimensions } });
});
const runtime = installSessionPaneRuntimeTestHarness({ scopeId: 'project:wr_1' });
let restoreWebGlobals: (() => void) | undefined;
beforeEach(() => { device.phone = false; router.replace.mockClear(); restoreWebGlobals = withPopoverWebGlobals(); });
afterEach(() => { restoreWebGlobals?.(); restoreWebGlobals = undefined; });
function workspaceRef(): WorkspaceRefV1 {
    return { id: 'wr_1', serverId: runtime.serverId, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 };
}
async function renderPanel(props: Partial<React.ComponentProps<typeof import('./ProjectRightPanel')['ProjectRightPanel']>> = {}) {
    const { ProjectRightPanel } = await import('./ProjectRightPanel');
    const screen = await renderScreen(<runtime.Wrapper />);
    await act(async () => runtime.pane.openRight({ tabId: 'git' }));
    await act(async () => screen.update(<runtime.Wrapper><ProjectRightPanel
        workspaceRef={workspaceRef()} scopeId="project:wr_1" activeRootPath="/repo" onSelectRootPath={() => {}} {...props}
    /></runtime.Wrapper>));
    return screen;
}
describe('ProjectRightPanel', () => {
    it('renders the canonical Git surface without a close affordance when the parent supplies none', async () => {
        const { WorkspaceRightPanelGitView } = await import('@/components/projects/scm/WorkspaceRightPanelGitView');
        const screen = await renderPanel();
        expect(screen.tree.findAllByType(WorkspaceRightPanelGitView)).toHaveLength(1);
        expect(screen.findHostByTestId('project-rightpanel-header')).not.toBeNull();
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('selects Files in the real pane and navigates to the sibling root-worktree mobile route', async () => {
        device.phone = true;
        const screen = await renderPanel({ activeWorktreeId: null, onRequestClose: () => {} });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith('/projects/wr_1/files?worktreeId=%40root');
        expect(screen.findHostByTestId('project-rightpanel-close')).toBeNull();
    });
    it('preserves the selected worktree in the sibling mobile route and pane selection', async () => {
        device.phone = true;
        const screen = await renderPanel({
            activeRootPath: '/repo/.worktrees/feature-auth', activeWorktreeId: 'gitwt_feature', onRequestClose: () => {},
        });
        await screen.pressByTestIdAsync('project-rightpanel-tab:files');
        expect(runtime.pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'files' });
        expect(router.replace).toHaveBeenCalledWith('/projects/wr_1/files?worktreeId=gitwt_feature');
    });
});
