import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let deviceType: 'phone' | 'tablet' | 'desktop' = 'phone';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'cockpit';
let scopeState: any = {
    right: { isOpen: true, activeTabId: 'git', tabState: {} },
    details: {
        isOpen: true,
        tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: '/repo/a.ts' } }],
        activeTabKey: 'file:a',
        tabState: {},
    },
};
const paneScopeMock = {
    get scopeState() {
        return scopeState;
    },
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
    closeDetails: vi.fn(),
    openDetailsTab: vi.fn(),
};

const routerMock = createExpoRouterMock({
    params: { workspaceRefId: 'wr_1' },
    navigation: { canGoBack: () => true },
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
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
    useNavigation: () => ({
        canGoBack: () => true,
    }),
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

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => {
            if (key === 'mobileWorkspaceExperienceV1') {
                return mobileWorkspaceExperience;
            }
            return null;
        },
    });
});

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/components/projects/detail/ProjectDetailsMainPanel', () => ({
    ProjectDetailsMainPanel: (props: Record<string, unknown>) => React.createElement('ProjectDetailsMainPanelStub', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectBrowseFilesSurface', () => ({
    ProjectBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('ProjectBrowseFilesSurfaceStub', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectGitSurface', () => ({
    ProjectGitSurface: (props: Record<string, unknown>) => React.createElement('ProjectGitSurfaceStub', props),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: (props: Record<string, unknown>) => React.createElement('ProjectTerminalSurfaceStub', props),
}));

vi.mock('@/components/projects/detail/useProjectSurfaceActions', () => ({
    useProjectSurfaceActions: () => ({
        openFileInDetails: vi.fn(),
        openFileInDetailsPinned: vi.fn(),
        openReviewAllChanges: vi.fn(),
        openStashDetails: vi.fn(),
        openCreateWorktreeFlow: vi.fn(),
        openCommitInDetails: vi.fn(),
        revealInFilesTree: vi.fn(),
    }),
}));

vi.mock('@/sync/domains/workspaces/workspaceScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/workspaces/workspaceScope')>();
    return {
        ...actual,
        buildWorkspaceCacheKey: () => 'workspace-cache-key',
    };
});

describe('project details route in cockpit mode with the real shell', () => {
    beforeEach(() => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        scopeState = {
            right: { isOpen: true, activeTabId: 'git', tabState: {} },
            details: {
                isOpen: true,
                tabs: [{ key: 'file:a', kind: 'file', resource: { kind: 'file', path: '/repo/a.ts' } }],
                activeTabKey: 'file:a',
                tabState: {},
            },
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the real cockpit shell without crashing when details are already open', async () => {
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/details')).default as React.ComponentType;
        const screen = await renderScreen(<Screen />);

        expect(screen.root.findByType('ProjectDetailsMainPanelStub' as never).props.forceOverviewMode).toBe(false);
    });
});
