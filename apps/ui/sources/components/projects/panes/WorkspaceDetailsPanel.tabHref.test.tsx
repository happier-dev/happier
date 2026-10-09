import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type { DetailsSplitWorkspaceProps } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { createBrowserLaunchpadDetailsTab } from '@/components/browser/surfaces/browserSurfaceDetailsTabModel';

installPanelCommonModuleMocks();
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

afterEach(standardCleanup);

describe('workspace Details tab destinations', () => {
    it('keeps tabs without a shareable route local while preserving scoped file destinations', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        const screen = await renderScreen(<AppPaneProvider><WorkspaceDetailsPanel
            workspaceRef={{ id: 'workspace-tab-href', serverId: 'home-test', machineId: 'machine-test', rootPath: '/repo', createdAtMs: 1 }}
            scopeId="project:workspace-tab-href" forceOverviewMode
        /></AppPaneProvider>);
        const { resolveTabHref } = screen.find(node => typeof node.props.resolveTabHref === 'function').props as DetailsSplitWorkspaceProps;
        if (!resolveTabHref) throw new Error('Expected workspace Details route owner');
        const localTab: DetailsTabState = { ...createBrowserLaunchpadDetailsTab(), isPinned: false, isPreview: false };
        expect(resolveTabHref(localTab)).toBeNull();
        const fileTab: DetailsTabState = { key: 'file:src/app.ts', kind: 'file', title: 'app.ts', resource: { kind: 'file', path: 'src/app.ts' }, isPinned: false, isPreview: false };
        const href = resolveTabHref(fileTab);
        if (!href) throw new Error('Expected shareable file destination');
        const url = new URL(href, 'https://happier.test');
        expect(url.pathname).toBe('/projects/workspace-tab-href/code');
        expect(url.searchParams.get('initialFile')).toBe('src/app.ts');
    });
});
