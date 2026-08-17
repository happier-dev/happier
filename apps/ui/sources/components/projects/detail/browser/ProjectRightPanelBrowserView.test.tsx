import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    applyOpenDetailsTab,
    createEmptyPaneDetailsState,
} from '@/components/appShell/panes/details/workspace/detailsWorkspaceReducer';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { createBrowserViewDetailsTab } from '@/components/browser/surfaces/browserSurfaceDetailsTabModel';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { EMPTY_PLUGIN_BROWSER_PROJECTION } from '@/sync/domains/plugins/browser/targets';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => ({ machineId: 'machine_1', serverId: 'server_1' }),
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'unavailable',
        interactionEnabled: false,
        machineId: null,
        serverId: null,
        platform: 'ios',
    }),
}));

const paneStub = vi.hoisted(() => ({ current: null as AppPaneScopeApi | null }));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneStub.current,
}));

vi.mock('@/components/browser/surfaces/BrowserSurfaceHost', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => (
        React.createElement('BrowserSurfaceHostMock', { ...props })
    ),
    mergeBrowserSurfaceProductModels: (a: unknown, b: unknown) => a ?? b,
}));

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: { title: 'Preview' },
} as const;

const currentPluginProjection = {
    pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 19 },
    pluginBrowserProjection: { ...EMPTY_PLUGIN_BROWSER_PROJECTION, generation: 19 },
    phase: 'current',
    interactionEnabled: true,
    machineId: 'machine-projection',
    serverId: 'server-projection',
    platform: 'ios',
} satisfies PluginUiProjectionCurrentness;

function basePane(): AppPaneScopeApi {
    return {
        scopeId: 'project:workspace_1:mobile-browser',
        scopeState: null,
        openDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        closeDetails: vi.fn(),
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        splitDetailsGroup: vi.fn(),
        moveDetailsTabToGroup: vi.fn(),
        focusDetailsGroup: vi.fn(),
        setMaximizedDetailsGroup: vi.fn(),
        setDetailsSplitRatio: vi.fn(),
        closeDetailsGroup: vi.fn(),
    } as unknown as AppPaneScopeApi;
}

describe('ProjectRightPanelBrowserView (scoped workspace)', () => {
    it('mounts the SAME details-workspace engine and activates a browser-view tab', async () => {
        const tab = createBrowserViewDetailsTab({ target, scope: 'mobile' });
        const details = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(details) },
        } as AppPaneScopeApi;
        const { ProjectRightPanelBrowserView } = await import('./ProjectRightPanelBrowserView');

        const screen = await renderScreen(
            <ProjectRightPanelBrowserView workspaceRefId="workspace_1" scopeId="project:workspace_1:mobile-browser" />,
        );

        expect(screen.root.findAllByType('BrowserSurfaceHostMock').length).toBeGreaterThan(0);
    });

    it('threads an admitted projection through the project Browser host without inventing a Session id', async () => {
        const tab = createBrowserViewDetailsTab({ target, scope: 'mobile' });
        const details = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(details) },
        } as AppPaneScopeApi;
        const { ProjectRightPanelBrowserView } = await import('./ProjectRightPanelBrowserView');
        const ScreenWithProjection = ProjectRightPanelBrowserView as unknown as React.ComponentType<
            React.ComponentProps<typeof ProjectRightPanelBrowserView> & Readonly<{
                pluginProjection: PluginUiProjectionCurrentness;
            }>
        >;

        const screen = await renderScreen(
            <ScreenWithProjection
                workspaceRefId="workspace_1"
                scopeId="project:workspace_1:mobile-browser"
                pluginProjection={currentPluginProjection}
            />,
        );

        const host = screen.root.findAllByType('BrowserSurfaceHostMock')[0];
        expect(host?.props.pluginUiProjection).toBe(currentPluginProjection.pluginUiProjection);
        expect(host?.props.pluginUiInteractionEnabled).toBe(true);
        expect(host?.props.pluginBrowserProjection).toBe(currentPluginProjection.pluginBrowserProjection);
        expect(host?.props.pluginBrowserActionContext).toEqual({
            machineId: 'machine-projection',
            serverId: 'server-projection',
            sessionId: null,
        });
    });

    it('keeps a retained project Browser projection visible but noninteractive despite a stale boolean', async () => {
        const tab = createBrowserViewDetailsTab({ target, scope: 'mobile' });
        const details = applyOpenDetailsTab(createEmptyPaneDetailsState(), { tab, openAs: 'pinned' });
        paneStub.current = {
            ...basePane(),
            scopeState: { details: buildDetailsWorkspaceStateView(details) },
        } as AppPaneScopeApi;
        const { ProjectRightPanelBrowserView } = await import('./ProjectRightPanelBrowserView');
        const ScreenWithProjection = ProjectRightPanelBrowserView as unknown as React.ComponentType<
            React.ComponentProps<typeof ProjectRightPanelBrowserView> & Readonly<{
                pluginProjection: PluginUiProjectionCurrentness;
            }>
        >;

        const screen = await renderScreen(
            <ScreenWithProjection
                workspaceRefId="workspace_1"
                scopeId="project:workspace_1:mobile-browser"
                pluginProjection={{ ...currentPluginProjection, phase: 'retainedOffline' }}
            />,
        );

        expect(screen.root.findAllByType('BrowserSurfaceHostMock')[0]?.props
            .pluginUiInteractionEnabled).toBe(false);
    });
});
