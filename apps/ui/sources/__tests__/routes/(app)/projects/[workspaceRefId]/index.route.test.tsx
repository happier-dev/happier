import * as React from 'react';

import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const openDetailsTabSpy = vi.hoisted(() => vi.fn());
const appPaneScopeMock = vi.hoisted(() => ({
    scopeState: { right: { activeTabId: 'files' }, details: { isOpen: false, tabs: [] } },
}));
const stackOptionsCapture = createStackOptionsCapture();
let deviceTypeMock: 'phone' | 'desktop' = 'phone';
const workspaceRefMock = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};
const routerMock = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' },
    stackOptionsCapture,
    navigation: { canGoBack: () => true },
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/components/projects/ProjectDetailScreen', () => ({
    ProjectDetailScreen: (props: any) => React.createElement('ProjectDetailScreenStub', props),
}));

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({
    CodeEditor: () => null,
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: appPaneScopeMock.scopeState,
        openDetailsTab: openDetailsTabSpy,
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useNavigation: () => ({
        canGoBack: () => true,
    }),
}));

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'project-terminal-1',
}));

describe('project index route', () => {
    it('redirects phone users to the last-used project sub-route', async () => {
        deviceTypeMock = 'phone';
        const { default: ProjectIndexRoute } = await import('@/app/(app)/projects/[workspaceRefId]/index');

        const screen = await renderScreen(<ProjectIndexRoute />);

        const redirect = screen.tree.findByType('Redirect');
        expect(redirect.props).toMatchObject({ href: '/projects/wr_1/files?worktreeId=%40root' });
    });

    it('configures the shared project stack header for the desktop route', async () => {
        deviceTypeMock = 'desktop';
        stackOptionsCapture.reset();
        routerMock.spies.replace.mockClear();
        openDetailsTabSpy.mockClear();

        const { default: ProjectIndexRoute } = await import('@/app/(app)/projects/[workspaceRefId]/index');
        await renderScreen(<ProjectIndexRoute />);

        expect(stackOptionsCapture.getResolved()).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'Project Alpha',
            headerBackTitle: 'common.back',
        }));
        expect(typeof stackOptionsCapture.getResolved()?.headerLeft).toBe('function');
        expect(typeof stackOptionsCapture.getResolved()?.headerRight).toBe('function');

        const options = stackOptionsCapture.getResolved();
        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));

        await act(async () => {
            headerTree.root.findByProps({ testID: 'project-desktop-header-open-worktrees' }).props.onPress();
        });
        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=%40root&showWorktrees=1');

        await act(async () => {
            headerTree.root.findByProps({ testID: 'project-desktop-header-open-terminal' }).props.onPress();
        });
        expect(openDetailsTabSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'terminal:project:wr_1:terminal',
                kind: 'terminal',
                title: 'settings.terminal',
                resource: {
                    kind: 'terminal',
                    terminalInstanceId: 'project:wr_1:terminal',
                    cwd: '/repo',
                },
            }),
            expect.objectContaining({ intent: 'pinned' }),
        );
    });
});
