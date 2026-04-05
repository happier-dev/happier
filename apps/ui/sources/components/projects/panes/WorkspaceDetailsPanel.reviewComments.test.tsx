import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

const routerPushSpy = vi.fn();
const workspaceScmReviewDetailsViewSpy = vi.hoisted(() => vi.fn((_props: unknown) => null));
const paneDetailsTabsPanelSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement(
    React.Fragment,
    null,
    props.renderHeaderActions?.(),
)));

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: routerPushSpy,
    }),
}));

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
        scopeState: { details: { tabState: {} } },
        closeDetails: vi.fn(),
        openDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

vi.mock('@/components/appShell/panes/details/PaneDetailsTabsPanel', () => ({
    PaneDetailsTabsPanel: (props: any) => paneDetailsTabsPanelSpy(props),
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

vi.mock('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane', () => ({
    WorkspaceEmbeddedTerminalPane: () => null,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const original = await importOriginal<any>();
    return {
        ...original,
        useAllMachines: () => [],
        useLocalSetting: () => false,
        useLocalSettingMutable: () => [false, vi.fn()],
        useWorkspaceReviewCommentsDrafts: () => [{
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
        }],
    };
});

describe('WorkspaceDetailsPanel review comment launcher', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        workspaceScmReviewDetailsViewSpy.mockReset();
        paneDetailsTabsPanelSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('opens the new-session route for the active project worktree without storing a parallel review-comment seed', async () => {
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
            />,
        );

        await pressTestInstanceAsync(
            rendered.findByTestId('workspace-details-open-review-comments-session'),
            'workspace-details-open-review-comments-session',
        );

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-1',
                directory: '/repo/worktree-a',
                spawnServerId: 'server-1',
            },
        });
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

        const [{ renderTabContent }] = paneDetailsTabsPanelSpy.mock.calls.at(-1) ?? [];

        expect(typeof renderTabContent).toBe('function');

        const tabContent = renderTabContent({
            key: 'scm-review',
            kind: 'custom',
            title: 'Review',
            resource: { kind: 'scmReview' },
        });
        expect(React.isValidElement(tabContent)).toBe(true);
        expect((tabContent as React.ReactElement).props).toEqual(expect.objectContaining({
            rootPath: '/repo/worktree-a',
            machineId: 'machine-1',
            serverId: 'server-1',
        }));
    });

    it('allows project surfaces to hide the terminal and focus-mode header actions', async () => {
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
                showFocusModeToggle={false}
            />,
        );

        expect(rendered.findByTestId('workspace-details-open-terminal')).toBeNull();
        expect(
            rendered.root.findAll((node) =>
                node.props?.accessibilityLabel === 'session.detailsPanel.enterFocusModeA11y'
                || node.props?.accessibilityLabel === 'session.detailsPanel.exitFocusModeA11y')
                .length,
        ).toBe(0);
    });
});
