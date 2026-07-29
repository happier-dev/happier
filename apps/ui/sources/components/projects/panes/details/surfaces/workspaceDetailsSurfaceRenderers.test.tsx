import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props, testID: props.testID ?? 'browser-view-details-surface' })
    ),
    mergeBrowserSurfaceProductModels: (
        primary: Record<string, unknown> | null | undefined,
        fallback: Record<string, unknown> | null | undefined,
    ) => primary ?? fallback,
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

describe('workspace details surface renderers', () => {
    it('renders browser resources through the reusable browser surface host outside sessions', async () => {
        const { createWorkspaceDetailsSurfaceRenderers } = await import('./workspaceDetailsSurfaceRenderers');
        const target = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: { title: 'Preview', addressLabel: 'localhost:5173' },
        } as const;
        const { createBrowserViewDetailsTab } = await import('@/components/browser/surfaces');
        const tab = {
            ...createBrowserViewDetailsTab({ target, browserSessionId: 'browser_session_wr_1' }),
            isPinned: true,
            isPreview: false,
        };
        const launchpadRows = [{
            id: 'localService:preview_1',
            section: 'running',
            sourceKind: 'localService',
            title: 'Preview',
            subtitle: 'localhost:5173',
            detail: 'registered_preview',
            target,
            currentUrl: 'https://preview-1.preview.happier.test/',
            disabledReason: null,
            lastSeenAt: 1_000,
        }] satisfies readonly BrowserLaunchpadRow[];
        const renderers = createWorkspaceDetailsSurfaceRenderers({
            scopeId: 'project:wr_1',
            workspaceRefId: 'wr_1',
            workspaceCacheKey: 'workspace:wr_1',
            workspaceScope: {
                serverId: 'server_1',
                machineId: 'machine_1',
                rootPath: '/repo',
            },
            serverId: 'server_1',
            machineId: 'machine_1',
            rootPath: '/repo',
            activeRootPath: '/repo',
            presentation: 'panel',
            pinDetailsTab: vi.fn(),
            openFileTab: vi.fn(),
            renderWorkspaceInfo: () => React.createElement('WorkspaceInfo'),
            platform: 'web',
            launchpadRows,
            launchpadRefreshStatus: 'idle',
            launchpadRefreshError: null,
        });
        const input = {
            tab,
            descriptor: {
                surfaceId: 'project:wr_1:details:browser:preview_1',
                resourceKey: 'browser:preview_1',
                scope: {
                    kind: 'project',
                    workspaceRefId: 'wr_1',
                    serverId: 'server_1',
                    machineId: 'machine_1',
                    rootPath: '/repo',
                    activeRootPath: '/repo',
                },
                region: 'details',
                status: 'available',
            } as const,
            scope: {
                kind: 'project',
                workspaceRefId: 'wr_1',
                serverId: 'server_1',
                machineId: 'machine_1',
                rootPath: '/repo',
                activeRootPath: '/repo',
            } as const,
            region: 'details' as const,
            active: true,
            callbacks: {},
        };
        const renderer = renderers.find((candidate) => candidate.canRender(input));

        expect(renderer?.owner).toBe('browser');

        const screen = await renderScreen(<>{renderer?.render(input)}</>);
        const host = screen.findByTestId('browser-view-details-surface');

        expect(host).not.toBeNull();
        expect(host?.props.browserSessionId).toBe('browser_session_wr_1');
        expect(host?.props.presentationSlotId).toBe('project:wr_1:details:browser:preview_1');
        expect(host?.props.initialBrowserState.currentTarget).toEqual(target);
        expect(host?.props.launchpadRows).toBe(launchpadRows);
        expect(host?.props.launchpadRefreshStatus).toBe('idle');
        expect(host?.props.launchpadRefreshError).toBeNull();
    });
});
