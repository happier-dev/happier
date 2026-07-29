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

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => ({ machineId: 'machine_1', serverId: 'server_1' }),
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
});
