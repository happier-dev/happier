import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { ReviewCommentDraftMessageV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';

const routerPushSpy = vi.hoisted(() => vi.fn());
const workspaceScmReviewDetailsViewSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const projectTerminalSurfaceSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const detailsSplitWorkspaceSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement(
    React.Fragment,
    null,
    props.renderStripActions?.(),
    props.renderHeaderActions?.(),
)));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { push: routerPushSpy },
}).module);

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

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: { isOpen: false, activeTabId: null, tabState: {} }, details: { tabState: {} } },
        closeDetails: vi.fn(),
        openDetailsTab: openDetailsTabSpy,
        pinDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
    }),
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useDeviceType: () => 'desktop',
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

vi.mock('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace', () => ({
    DetailsSplitWorkspace: (props: any) => detailsSplitWorkspaceSpy(props),
}));

vi.mock('@/components/workspaces/files/details/WorkspaceFileDetailsView', () => ({
    WorkspaceFileDetailsView: () => null,
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceCommitDetailsView', () => ({
    WorkspaceCommitDetailsView: () => null,
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView', () => ({
    WorkspaceScmReviewDetailsView: (props: unknown) => workspaceScmReviewDetailsViewSpy(props),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmStashDetailsView', () => ({
    WorkspaceScmStashDetailsView: () => null,
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: (props: unknown) => {
        projectTerminalSurfaceSpy(props);
        return null;
    },
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'terminal-instance-2',
}));


describe('WorkspaceDetailsPanel review comment launcher', () => {
    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        storage.getState().upsertWorkspaceReviewCommentDraft(buildWorkspaceCacheKey({ serverId: 'server-1', machineId: 'machine-1', rootPath: '/repo/worktree-a' }), ReviewCommentDraftMessageV1Schema.parse({
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }));

        routerPushSpy.mockReset();
        workspaceScmReviewDetailsViewSpy.mockReset();
        projectTerminalSurfaceSpy.mockReset();
        openDetailsTabSpy.mockReset();
        detailsSplitWorkspaceSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('passes the active worktree path into project review details tabs', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
            />,
        );

        const [{ renderTabContent }] = detailsSplitWorkspaceSpy.mock.calls.at(-1) ?? [];

        expect(typeof renderTabContent).toBe('function');

        const tabContent = renderTabContent({
            key: 'scm-review',
            kind: 'custom',
            title: 'Review',
            resource: { kind: 'scmReview' },
        });
        expect(React.isValidElement(tabContent)).toBe(true);
        await renderScreen(tabContent as React.ReactElement);
        expect(workspaceScmReviewDetailsViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            rootPath: '/repo/worktree-a',
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
    });

    it('allows project surfaces to hide the terminal header action', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');

        const rendered = await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
                showTerminalHeaderAction={false}
            />,
        );

        expect(rendered.findByTestId('workspace-details-open-terminal')).toBeNull();
    });

    it('passes terminal instance ids into project terminal tabs', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
            />,
        );

        const [{ renderTabContent }] = detailsSplitWorkspaceSpy.mock.calls.at(-1) ?? [];
        const tabContent = renderTabContent({
            key: 'terminal:terminal-instance-2',
            kind: 'terminal',
            title: 'Terminal',
            resource: { kind: 'terminal', terminalInstanceId: 'terminal-instance-2' },
        });

        expect(React.isValidElement(tabContent)).toBe(true);
        await renderScreen(tabContent as React.ReactElement);
        expect(projectTerminalSurfaceSpy).toHaveBeenCalledWith(expect.objectContaining({
            terminalInstanceId: 'terminal-instance-2',
        }));
    });

    it('provides stable project details tab test ids for opened tabs', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
            />,
        );

        const [{ testIds }] = detailsSplitWorkspaceSpy.mock.calls.at(-1) ?? [];
        expect(testIds?.root).toBe('workspace-details-panel-root');
        expect(testIds?.tab?.('file_src_index_ts')).toBe('workspace-details-tab-file_src_index_ts');
        expect(testIds?.tabClose?.('file_src_index_ts')).toBe('workspace-details-tab-close-file_src_index_ts');
    });
});
