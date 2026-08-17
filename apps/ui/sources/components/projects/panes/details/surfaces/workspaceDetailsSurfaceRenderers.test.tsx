import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { createPluginDetailsDestinationTab } from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';

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

    it('registers the canonical qualified plugin details renderer for project tabs', async () => {
        const { createWorkspaceDetailsSurfaceRenderers } = await import('./workspaceDetailsSurfaceRenderers');
        const binding = normalizePluginUiDestinationBindingV1({
            pluginId: 'com.example.viewer',
            destinationId: 'workspace-file',
            rendererId: 'workspace-file-renderer',
            container: 'detailsTab',
            target: { kind: 'project', workspaceRefIdPath: '/workspace/id' },
        });
        if (!binding) throw new Error('project details fixture must be admitted');
        const placement = {
            id: 'surfacePlacement:com.example.viewer:workspace-file',
            pluginId: 'com.example.viewer',
            contributionKind: 'surfacePlacement' as const,
            descriptorId: 'workspace-file',
            binding,
            target: binding.target,
            renderer: { kind: 'reactNative', contributionId: 'workspace-file-renderer' },
            display: { developerFallback: 'Workspace file viewer' },
            availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
            headerActions: [],
        } satisfies PluginUiSurfacePlacementProjection;
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 4,
            surfacePlacementsById: { [placement.id]: placement },
        };
        const tab = {
            ...createPluginDetailsDestinationTab({
                destination: { pluginId: 'com.example.viewer', localId: 'workspace-file' },
                title: 'Workspace file viewer',
            }),
            isPinned: true,
            isPreview: false,
        };
        const renderers = createWorkspaceDetailsSurfaceRenderers({
            scopeId: 'project:wr_1',
            workspaceRefId: 'wr_1',
            workspaceCacheKey: 'workspace:wr_1',
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            activeRootPath: '/repo',
            presentation: 'panel',
            pinDetailsTab: vi.fn(),
            openFileTab: vi.fn(),
            renderWorkspaceInfo: () => React.createElement('WorkspaceInfo'),
            pluginUiProjection: projection,
            pluginUiProjectionPhase: 'current',
            pluginUiInteractionEnabled: true,
            platform: 'web',
        });
        const renderInput = {
            tab,
            descriptor: {
                surfaceId: 'project:wr_1:details:plugin-file',
                resourceKey: 'pluginDetailsDestination:plugin-file',
                scope: {
                    kind: 'project' as const,
                    workspaceRefId: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo',
                },
                region: 'details' as const,
                status: 'available' as const,
            },
            scope: {
                kind: 'project' as const,
                workspaceRefId: 'wr_1',
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
            region: 'details' as const,
            active: true,
            callbacks: {},
        };

        const renderer = renderers.find((candidate) => candidate.id === 'plugin-details-destination:project');

        expect(renderer).toBeDefined();
        expect(renderer?.canRender(renderInput)).toBe(true);
    });

    it('passes the current project file-tab context to the shared openable-content viewer owner', async () => {
        const { createWorkspaceDetailsSurfaceRenderers } = await import('./workspaceDetailsSurfaceRenderers');
        const replaceTab = vi.fn();
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 9 };
        const renderers = createWorkspaceDetailsSurfaceRenderers({
            scopeId: 'project:wr_1',
            workspaceRefId: 'wr_1',
            workspaceCacheKey: 'workspace:wr_1',
            workspaceScope: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
            activeRootPath: '/repo',
            presentation: 'panel',
            pinDetailsTab: vi.fn(),
            openFileTab: vi.fn(),
            renderWorkspaceInfo: () => React.createElement('WorkspaceInfo'),
            pluginUiProjection: projection,
            pluginUiProjectionPhase: 'current',
            pluginUiInteractionEnabled: true,
            platform: 'web',
        });
        const renderInput = {
            tab: {
                key: 'file:README.md',
                kind: 'file',
                title: 'README.md',
                resource: { kind: 'file', path: 'README.md' },
                isPinned: true,
                isPreview: false,
            },
            descriptor: {
                surfaceId: 'project:wr_1:details:file:README.md',
                resourceKey: 'file:README.md',
                scope: {
                    kind: 'project' as const,
                    workspaceRefId: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo',
                },
                region: 'details' as const,
                status: 'available' as const,
            },
            scope: {
                kind: 'project' as const,
                workspaceRefId: 'wr_1',
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
            region: 'details' as const,
            active: true,
            callbacks: { replaceTab },
        };
        const renderer = renderers.find((candidate) => candidate.id === 'workspace-file');

        const rendered = renderer?.render(renderInput);

        expect(React.isValidElement(rendered)).toBe(true);
        if (!React.isValidElement<{ openableContentViewer?: unknown }>(rendered)) return;
        expect(rendered.props.openableContentViewer).toMatchObject({
            targetKind: 'project',
            projection,
            details: renderInput,
            scopedLaunchFacts: {
                serverId: 'server-1',
                machineId: 'machine-1',
                generation: 9,
                interactionEnabled: true,
            },
        });
    });
});
