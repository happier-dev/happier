import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const detailsSplitWorkspaceSpy = vi.hoisted(() => vi.fn((props: {
    renderHeaderActions?: (() => React.ReactNode) | null;
}) => React.createElement(React.Fragment, null, props.renderHeaderActions?.())));

vi.mock('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace', () => ({
    DetailsSplitWorkspace: (props: Parameters<typeof detailsSplitWorkspaceSpy>[0]) => detailsSplitWorkspaceSpy(props),
}));

vi.mock('@/components/appShell/panes/details/surfaces', () => ({
    DetailsSurfaceHost: (props: unknown) => React.createElement('DetailsSurfaceHostMock', { props }),
    createDetailsSurfacePaneCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { isOpen: false },
            details: {
                isOpen: true,
                activeTabKey: null,
                tabs: [],
                groups: [],
                root: null,
                tabState: {},
            },
        },
        closeDetails: vi.fn(),
        openDetailsTab: openDetailsTabSpy,
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'unavailable',
        interactionEnabled: false,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    }),
}));

vi.mock('@/components/workspaces/files/details/WorkspaceFileDetailsView', () => ({
    WorkspaceFileDetailsView: () => React.createElement('WorkspaceFileDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceCommitDetailsView', () => ({
    WorkspaceCommitDetailsView: () => React.createElement('WorkspaceCommitDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView', () => ({
    WorkspaceScmReviewDetailsView: () => React.createElement('WorkspaceScmReviewDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmStashDetailsView', () => ({
    WorkspaceScmStashDetailsView: () => React.createElement('WorkspaceScmStashDetailsView'),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: () => React.createElement('ProjectTerminalSurface'),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useLocalSetting: () => false,
        useLocalSettingMutable: () => [false, vi.fn()],
        useWorkspaceReviewCommentsDrafts: () => [],
    });
});

describe('WorkspaceDetailsPanel browser product mount', () => {
    it('opens the browser launchpad as a generic browser details surface tab', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        openDetailsTabSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    createdAtMs: 1_700_000_000_000,
                    label: 'Repo',
                }}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
            />,
        );

        const headerActions = detailsSplitWorkspaceSpy.mock.calls.at(-1)?.[0].renderHeaderActions?.();
        expect(headerActions).toBeTruthy();
        const headerScreen = await renderScreen(<>{headerActions}</>);

        await headerScreen.pressByTestIdAsync('workspace-details-open-browser');

        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'browser:launchpad',
                kind: 'browser-view',
                resource: expect.objectContaining({
                    kind: 'browser-view',
                    mode: 'launchpad',
                }),
            }),
            { intent: 'pinned' },
        );
    });
});
