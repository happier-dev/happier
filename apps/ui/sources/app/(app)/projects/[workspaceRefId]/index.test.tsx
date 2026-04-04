import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const appPaneScopeMock = vi.hoisted(() => ({
    scopeState: { right: { activeTabId: 'files' } },
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: { workspaceRefId: 'wr_1' },
    }).module;
});

vi.mock('@/components/projects/ProjectDetailScreen', () => ({
    ProjectDetailScreen: (props: any) => React.createElement('ProjectDetailScreenStub', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: appPaneScopeMock.scopeState,
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

describe('project index route', () => {
    it('redirects phone users to the last-used project sub-route', async () => {
        const { default: ProjectIndexRoute } = await import('./index');

        const screen = await renderScreen(<ProjectIndexRoute />);

        const redirect = screen.tree.findByType('Redirect');
        expect(redirect.props).toMatchObject({ href: '/projects/wr_1/files' });
    });
});
