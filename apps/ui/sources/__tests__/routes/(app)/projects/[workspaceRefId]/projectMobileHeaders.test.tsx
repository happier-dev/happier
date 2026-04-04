import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const stackOptionsCapture = createStackOptionsCapture();
const routerMock = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' },
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

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null, tabState: {} },
        },
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        closeDetails: vi.fn(),
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
        stackOptionsCapture.reset();
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
            headerTitle: 'Project Alpha',
            headerBackTitle: 'common.back',
        }));
    });
});
