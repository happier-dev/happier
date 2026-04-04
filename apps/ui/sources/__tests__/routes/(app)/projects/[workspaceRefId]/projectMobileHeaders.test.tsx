import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stackOptionsCapture = createStackOptionsCapture();
const paneOpenDetailsTabSpy = vi.fn();
const setLocalSettingSpy = vi.fn();
let localSettingsMock: Record<string, unknown> = {};
let paneScopeStateMock: {
    right: { isOpen: boolean; activeTabId: string | null; tabState: Record<string, unknown> };
    details: {
        isOpen: boolean;
        tabs: Array<{ key: string; kind: string; resource: { kind: string; path: string } }>;
        activeTabKey: string | null;
        tabState: Record<string, unknown>;
    };
} = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
    details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
};
const routerMock = createExpoRouterMock({
    params: {
        workspaceRefId: 'wr_1',
        activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
    },
    navigation: { canGoBack: () => true },
    stackOptionsCapture,
    router: {
        push: vi.fn(),
        back: vi.fn(),
        replace: vi.fn(),
        setParams: vi.fn(),
    },
});

const workspaceRefMock = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/Users/test/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/utils/platform/deferOnWeb', () => ({
    deferOnWeb: (action: () => void) => action(),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                localSettingsMock[key] = value;
                setLocalSettingSpy(value);
            },
        ],
    });
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: paneScopeStateMock,
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        closeDetails: vi.fn(),
        openDetailsTab: paneOpenDetailsTabSpy,
    }),
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

describe('project mobile route headers', () => {
    beforeEach(() => {
        localSettingsMock = {};
        paneScopeStateMock = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        };
        setLocalSettingSpy.mockClear();
        stackOptionsCapture.reset();
        paneOpenDetailsTabSpy.mockClear();
        routerMock.spies.push.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git'],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files'],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details'],
    ])('sets the native header title for the %s route', async (_name, moduleId) => {
        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(stackOptionsCapture.getResolved()).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'Project Alpha · feature-auth',
            headerBackTitle: 'common.back',
        }));
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', { wr_1: 'git' }],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', { wr_1: 'files' }],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details', { wr_1: 'git' }],
    ])('persists the current mobile project subroute for the %s route', async (_name, moduleId, expected) => {
        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).toHaveBeenCalledWith(expected);
    });

    it('does not overwrite the remembered active root path just by opening a route with an activeRootPath query param', async () => {
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/git')).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).not.toHaveBeenCalledWith({
            wr_1: '/Users/test/repo/.worktrees/feature-auth',
        });
    });

    it('persists the details route when a fullscreen detail tab is actually present', async () => {
        paneScopeStateMock = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: 'a' } }],
                activeTabKey: 'file:a',
                tabState: {},
            },
        };
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default as React.ComponentType;
        await renderScreen(<Screen />);

        expect(setLocalSettingSpy).toHaveBeenCalledWith({ wr_1: 'details' });
    });

    it.each([
        ['git', '@/app/(app)/projects/[workspaceRefId]/git', true],
        ['files', '@/app/(app)/projects/[workspaceRefId]/files', true],
        ['details', '@/app/(app)/projects/[workspaceRefId]/details', false],
    ])('configures mobile header actions for the %s route', async (_name, moduleId, expectsWorktreesButton) => {
        const Screen = (await import(moduleId)).default as React.ComponentType;
        await renderScreen(<Screen />);

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerRight).toBe('function');

        const headerTree = await renderScreen(React.createElement(options!.headerRight as () => React.ReactElement));

        expect(headerTree.root.findByProps({ testID: 'project-mobile-header-open-terminal' })).toBeTruthy();
        const worktreeButtons = headerTree.root.findAllByProps({ testID: 'project-mobile-header-open-worktrees' });
        expect(worktreeButtons.length > 0).toBe(expectsWorktreesButton);

        if (expectsWorktreesButton) {
            await act(async () => {
                worktreeButtons[0]!.props.onPress();
            });
            expect(routerMock.spies.push).toHaveBeenCalledWith('/projects/wr_1/details?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth&showWorktrees=1');
        }

        const terminalButton = headerTree.root.findByProps({ testID: 'project-mobile-header-open-terminal' });
        await act(async () => {
            terminalButton.props.onPress();
        });
        expect(paneOpenDetailsTabSpy).toHaveBeenCalled();
    });
});
