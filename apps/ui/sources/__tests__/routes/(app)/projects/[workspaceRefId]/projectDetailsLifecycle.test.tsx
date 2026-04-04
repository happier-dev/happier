import * as React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const closeRightSpy = vi.fn();
const closeDetailsSpy = vi.fn();
const openRightSpy = vi.fn();
const setRightTabSpy = vi.fn();
let isFocused = true;
let navigationCanGoBack = true;
let scopeState: any = {
    right: { isOpen: true, activeTabId: 'files', tabState: {} },
    details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
};
const paneScopeMock = {
    get scopeState() {
        return scopeState;
    },
    openRight: openRightSpy,
    closeRight: closeRightSpy,
    setRightTab: setRightTabSpy,
    closeDetails: closeDetailsSpy,
};

const routerMock = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' },
    navigation: { canGoBack: () => navigationCanGoBack },
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
});

const workspaceRefMock = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => isFocused,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneScopeMock,
}));

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/components/projects/detail/ProjectRightPanel', () => ({
    ProjectRightPanel: (props: Record<string, unknown>) => React.createElement('ProjectRightPanelStub', props),
}));

vi.mock('@/components/projects/detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: (props: Record<string, unknown>) => React.createElement('ProjectDetailsMainPanelStub', props),
}));

let ProjectFilesRoute: React.ComponentType<any>;
let ProjectDetailsRoute: React.ComponentType<any>;

describe('project route details lifecycle', () => {
    beforeAll(async () => {
        ProjectFilesRoute = (await import('@/app/(app)/projects/[workspaceRefId]/files')).default;
        ProjectDetailsRoute = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default;
    }, 60_000);

    beforeEach(() => {
        isFocused = true;
        navigationCanGoBack = true;
        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        };
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        closeRightSpy.mockClear();
        closeDetailsSpy.mockClear();
        openRightSpy.mockClear();
        setRightTabSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('pushes the fullscreen details route again when the active details tab changes', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: 'a' } }],
                activeTabKey: 'file:a',
                tabState: {},
            },
        };

        const screen = await renderScreen(<ProjectFilesRoute />);
        expect(routerPushSpy).toHaveBeenCalledTimes(1);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/projects/wr_1/details');

        scopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:b', kind: 'file', resource: { kind: 'file', path: 'b' } }],
                activeTabKey: 'file:b',
                tabState: {},
            },
        };

        await screen.update(<ProjectFilesRoute />);

        expect(routerPushSpy).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).toHaveBeenLastCalledWith('/projects/wr_1/details');
    });

    it('closes details pane state when the fullscreen details route unmounts', async () => {
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: 'a' } }],
                activeTabKey: 'file:a',
                tabState: {},
            },
        };

        const screen = await renderScreen(<ProjectDetailsRoute />);
        await screen.unmount();

        expect(closeDetailsSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the current non-details project route when details are unavailable', async () => {
        navigationCanGoBack = false;
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        };

        await renderScreen(<ProjectDetailsRoute />);

        expect(routerReplaceSpy).toHaveBeenCalledWith('/projects/wr_1/git');
    });

    it('stays on the details route when explicitly opened in worktrees mode without detail tabs', async () => {
        navigationCanGoBack = false;
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            showWorktrees: '1',
        });
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        };

        await renderScreen(<ProjectDetailsRoute />);

        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
